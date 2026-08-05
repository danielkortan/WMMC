const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

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
// Scoreboard-specific webhook — points at the scoreboard channel, which is not the
// notifications channel. Deliberately NO fallback to SLACK_WEBHOOK_URL: holding the
// general webhook must never be enough to emit a scoreboard. The fallback meant any
// process configured only for swap notifications silently became a scoreboard poster
// (into the swaps channel, no less), which is both wrong output and one more way for a
// stray instance to reach the league. Unset = the auto-post disables itself, loudly.
const SLACK_SCOREBOARD_WEBHOOK_URL = process.env.SLACK_SCOREBOARD_WEBHOOK_URL || '';
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
// Per-call ceiling on the roast generation requests. Generous relative to a 300-token
// completion, but bounded: the combined Slack post generates one manager at a time, so a
// hung connection would otherwise hold up everyone behind it. On timeout the caller takes
// the static bank, same as any other failure.
const ROAST_API_TIMEOUT_MS = 30000;

async function postSlack(text, blocks) {
  if (!SLACK_WEBHOOK_URL) return;
  const body = blocks ? { text, blocks } : { text };
  await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The one place a scoreboard reaches the league channel. Every caller — the 7am auto-post, the
// commissioner's manual post, anything added later — inherits the guard below, so an
// unrestored/ephemeral instance cannot push a pool-play-shaped post mid-playoffs no matter which
// path it takes. The upstream hasScoreboardData checks exist to give better errors and to avoid
// consuming the day's post slot; this one is the backstop that cannot be bypassed.
async function postScoreboardSlack(db, year, opts) {
  if (!SLACK_SCOREBOARD_WEBHOOK_URL) return;
  const { blocks, text, round } = buildScoreboardBlocks(db, year, opts);
  if (!round) {
    throw new Error(
      `Refusing to post the ${year} scoreboard: no current round could be determined from this ` +
        `process's db.json (schedule_dates and the weekly stat rows are both unusable), so the post ` +
        `would render as the "Current Period: Season" pool-play shell.`
    );
  }
  await fetch(SLACK_SCOREBOARD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks }),
  });
}

// Post plain text to the scoreboard channel — the same webhook/process as the daily
// scoreboard post — for announcements that belong with the score updates rather than
// the swap-notification channel (e.g. the combined elimination-roast post).
async function postScoreboardChannelSlack(text) {
  if (!SLACK_SCOREBOARD_WEBHOOK_URL) return;
  await fetch(SLACK_SCOREBOARD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
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

// Upstash's REST /set rejects payloads over its request-size limit (~1 MB on the free tier). A full
// season's daily_batting/daily_pitching rows (the largest field by far — see the per-year save) push
// the raw db.json well past that, which is why the backup historically failed silently and UPSTASH_*
// ships unset. The backup only exists for disaster recovery, and those per-game rows are
// server-authoritative and re-derivable from the MLB Stats API (and the weekly rollups we keep drive
// standings). So every Upstash write stores a SLIM clone: full league/standings state minus the
// regenerable daily rows.
//
// IMPORTANT: this is backup-only. writeDB() still persists the FULL db.json to the Render disk (the
// source of truth the live site reads/writes); slimForBackup never mutates it and never runs on the
// disk path. A restore from a slim snapshot brings back standings immediately; per-game daily detail
// is repopulated by an MLB backfill (POST /api/mlb/backfill).
const UPSTASH_MAX_BYTES = 1024 * 1024; // ~1 MB Upstash /set request limit (free tier)

function slimForBackup(data) {
  if (!data || typeof data !== 'object') return data;
  const slim = { ...data };
  if (slim.seasons && typeof slim.seasons === 'object') {
    const seasons = {};
    for (const [year, sd] of Object.entries(slim.seasons)) {
      if (sd && typeof sd === 'object') {
        const { daily_batting: _db, daily_pitching: _dp, ...rest } = sd;
        seasons[year] = rest;
      } else {
        seasons[year] = sd;
      }
    }
    slim.seasons = seasons;
  }
  return slim;
}

// Single serialization point for every Upstash write (live mirror + dated backups + pre-restore
// snapshot). Slims first, then double-stringifies (Upstash /set wants a JSON string as its body), and
// warns loudly if the slimmed payload STILL exceeds the size limit — so an oversized backup can never
// fail silently again.
function serializeForUpstash(data, label) {
  const body = JSON.stringify(JSON.stringify(slimForBackup(data)));
  if (body.length > UPSTASH_MAX_BYTES) {
    console.error(
      `[Upstash] ${label || 'payload'} is ${body.length} bytes after slimming — exceeds the ~${UPSTASH_MAX_BYTES}-byte ` +
        `limit and will likely be rejected. The slim payload needs further trimming.`
    );
  }
  return body;
}

async function saveToUpstash(data) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { ok: false, skipped: true };
  const body = serializeForUpstash(data, 'live mirror (wmmc_db)');
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

// Low-level: write `data` to an explicit Upstash key with a TTL. The daily backup, the pre-restore
// safety snapshot, and any future named backup all funnel through here so the serialization quirk
// (Upstash wants a JSON string, hence the double-stringify) and TTL handling live in one place.
async function saveBackupKey(data, key, ttlSeconds = DB_BACKUP_TTL_SECONDS) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { ok: false, skipped: true };
  const body = serializeForUpstash(data, key);
  try {
    const resp = await fetch(`${UPSTASH_URL}/set/${key}?EX=${ttlSeconds}`, {
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

// Write a dated, auto-expiring snapshot of the DB under wmmc_db_bak_<YYYY-MM-DD>. Unlike the
// live UPSTASH_KEY (overwritten on every save, no history), these rotate themselves via EX and
// give ~2 weeks of daily restore points — so a bad write or boot migration is recoverable
// instead of lost. Called on boot, capturing the as-restored (pre-migration) state.
async function saveTimestampedBackup(data) {
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD; later deploys refresh same-day key
  return saveBackupKey(data, `${UPSTASH_KEY}_bak_${dateKey}`);
}

// Fetch a single dated backup snapshot (wmmc_db_bak_<YYYY-MM-DD>). Returns the parsed DB object, or
// null when the key is absent/expired/unreadable. Mirrors loadFromUpstash but for the rolling
// backups; used by the restore tooling (GET /api/admin/db-backups, POST /api/admin/db-restore).
async function loadTimestampedBackup(dateKey) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const resp = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}_bak_${dateKey}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    return result ? JSON.parse(result) : null;
  } catch (e) {
    console.error('[Upstash] Backup load failed:', dateKey, e.message);
    return null;
  }
}

// One-glance integrity summary of a DB snapshot for the restore-point picker: when it was last
// saved, how many managers it carries, and per active-or-not season the status + schedule_dates
// length (the field whose silent wipe motivated this tooling) + roster-attribution manager count.
function summarizeBackup(db) {
  const seasons = {};
  for (const [year, sd] of Object.entries((db && db.seasons) || {})) {
    seasons[year] = {
      status: (sd && sd.status) || null,
      schedule_dates: Array.isArray(sd && sd.schedule_dates) ? sd.schedule_dates.length : 0,
      rostered_managers: sd && sd.rosters && typeof sd.rosters === 'object' ? Object.keys(sd.rosters).length : 0,
    };
  }
  return {
    last_saved_at: (db && db.last_saved_at) || null,
    managers: ((db && db.managers) || []).length,
    seasons,
  };
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

// Bumped by writeDB. Part of the fingerprint that decides whether a cached db.json-derived
// payload is still good — see seasonsPayload.
let dbWriteCounter = 0;

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
  // Every write invalidates anything derived from db.json. Bumped BEFORE the write, not after, so
  // a write that throws part-way still drops the caches rather than leaving them claiming to
  // describe a file that may have changed. See seasonsPayload.
  dbWriteCounter++;
  // Stamp every write so startup can tell whether the local disk copy or the
  // Upstash backup is newer (prevents a stale backup from clobbering good data).
  data.last_saved_at = new Date().toISOString();
  // Atomic write: serialize to a temp file, fsync it to disk, then rename over the live file.
  // rename(2) is atomic on the same filesystem, so a crash/restart mid-write can never leave a
  // truncated or corrupt db.json — the previous good file stays intact until the new one is
  // fully durable. (Plain writeFileSync onto db.json leaves a corruption window.)
  // Compact (no-indent) JSON: with a season of daily_* rows the pretty-printed form roughly
  // doubles both this in-memory string and the on-disk file that every readDB() re-parses —
  // that transient was a contributor to the 2026-07-06 heap OOM crash loop.
  const json = JSON.stringify(data);
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
// Deterministic JSON (sorted object keys) so a content hash is stable regardless of key order.
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Optimistic-concurrency token (SAVE_HARDENING_PLAN.md, Layer 1). A content hash over ONLY the
// fields a stale full-season overwrite can corrupt: rosters, roster_dates, swaps, schedule_dates,
// and the submission buckets. Returned by GET /api/seasons as `_rev`; the full-season save must
// echo the value it loaded or the server rejects it (409). A stats-only sync never touches these
// fields, so it won't false-trip the gate. Computed on the fly — nothing to bump or persist.
function computeSeasonRev(sd) {
  if (!sd || typeof sd !== 'object') return '0';
  const relevant = {
    rosters: sd.rosters || {},
    roster_dates: sd.roster_dates || {},
    swaps: sd.swaps || [],
    schedule_dates: sd.schedule_dates || [],
    initial_submissions: sd.initial_submissions || {},
    period_submissions: sd.period_submissions || {},
  };
  return crypto.createHash('sha1').update(stableStringify(relevant)).digest('hex').slice(0, 16);
}

// Send a JSON payload with ETag revalidation + gzip. Used for the large, frequently re-fetched
// read endpoints (seasons, daily stats). Cache-Control: no-cache = browsers always revalidate,
// never serve stale without asking; an unchanged re-fetch is a 304 with zero body bytes, and an
// actual transfer is gzipped (~10x smaller for JSON). Express compresses nothing by default, and
// its automatic ETag is set too late to short-circuit the JSON work, so both are explicit here.
// Serialize + hash once, so a payload that hasn't changed can be served again without redoing
// either. The gzip is deliberately NOT computed here — a 304 never needs it, and it is the most
// expensive step of the three.
function buildJsonPayload(obj) {
  const body = JSON.stringify(obj);
  return {
    body,
    etag: '"' + crypto.createHash('sha1').update(body).digest('hex') + '"',
    gzip: null,
  };
}

function sendPreparedJson(req, res, payload) {
  res.set('ETag', payload.etag);
  res.set('Cache-Control', 'no-cache');
  res.set('Vary', 'Accept-Encoding');
  // includes() rather than equality: proxies may weaken the tag (W/"...") or the browser may
  // send several candidates comma-separated.
  if (String(req.headers['if-none-match'] || '').includes(payload.etag)) return res.status(304).end();
  res.set('Content-Type', 'application/json; charset=utf-8');
  if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
    // Compressed once and kept alongside the body: for a cached payload every later request is a
    // buffer write, and for an uncached one this costs exactly what it always did.
    if (!payload.gzip) payload.gzip = zlib.gzipSync(payload.body);
    res.set('Content-Encoding', 'gzip');
    return res.send(payload.gzip);
  }
  res.send(payload.body);
}

function sendJsonRevalidated(req, res, obj) {
  sendPreparedJson(req, res, buildJsonPayload(obj));
}

// GET /api/seasons is the most expensive read in the app, and every client hits it on load and on
// every tab switch. Building it means parsing the whole db.json (daily rows included — far more
// than it sends), serializing ~3 MB of client-facing season data, hashing it, and gzipping it.
// All of that is synchronous, so requests do not overlap: they queue behind whichever one is
// holding the event loop.
//
// Measured on production data: ~780 ms of blocked loop per call, and **the same for a 304**,
// because the ETag used to be derived FROM the serialized body — the server did the entire job
// before deciding to send nothing. Several of those queued behind each other is what a scoreboard
// that "never finishes" actually looks like.
//
// So build it once and hold it. The payload is a pure function of db.json, so the only question is
// whether the file has changed since. `dbWriteCounter` catches every in-process write (they all go
// through writeDB) and the file's mtime+size catches anything that replaced it from outside — the
// startup Upstash restore writes DB_FILE directly, and a commissioner may repair it by hand. That
// costs one statSync instead of a multi-megabyte read.
//
// Cost of holding it: the body string plus the gzip buffer, a few MB resident. That is the trade —
// a few MB of RSS against ~780 ms of blocked event loop on every request.
let seasonsPayloadCache = null;

function dbFingerprint() {
  try {
    const st = fs.statSync(DB_FILE);
    return `${dbWriteCounter}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${dbWriteCounter}:missing`;
  }
}

function seasonsPayload() {
  const fingerprint = dbFingerprint();
  if (seasonsPayloadCache && seasonsPayloadCache.fingerprint === fingerprint) {
    return seasonsPayloadCache.payload;
  }
  const db = readDB();
  const seasons = db.seasons || {};
  // Attach the concurrency token per season (not persisted) so the client can echo it on save.
  // Server-only fields are stripped from the client payload:
  // - score_snapshots: the score guard's diagnostic trail, written only by recordScoreSnapshot.
  // - daily_batting / daily_pitching: per-game rows from the MLB sync — the largest field and
  //   growing daily. Scoring reads weekly rows; the two client views that display daily data
  //   (Trends charts, per-week roster stat windows) fetch GET /api/seasons/:year/daily-stats
  //   on demand instead.
  // The save handlers restore all three from the stored season (server-authoritative), so their
  // absence from a client's later full-season save can never wipe them.
  const out = {};
  for (const [year, sd] of Object.entries(seasons)) {
    const { score_snapshots: _snaps, daily_batting: _db, daily_pitching: _dp, ...clientSd } = sd;
    out[year] = { ...clientSd, _rev: computeSeasonRev(sd) };
  }
  const payload = buildJsonPayload(out);
  seasonsPayloadCache = { fingerprint, payload };
  return payload;
}

app.get('/api/seasons', (req, res) => {
  sendPreparedJson(req, res, seasonsPayload());
});

// POST /api/seasons — save all seasons (full replace)
app.post('/api/seasons', requireCommissioner, (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object' });
  }
  const db = readDB();
  const incoming = req.body;

  // This bulk full-replace bypasses the per-season optimistic-concurrency gate and the per-field
  // merge guards — a stale or buggy caller could wipe every season's rosters/scores in one shot.
  // The current client never uses it (it saves per-year), so rather than leave the hole open, run
  // the same destructive-save integrity check per season and refuse a destructive replacement
  // unless explicitly forced. (SAVE_HARDENING_PLAN.md Phase 2 — bulk-endpoint cleanup.)
  if (req.body.force !== true) {
    const blocked = [];
    for (const [year, candidate] of Object.entries(incoming)) {
      if (year === 'force') continue;
      const existing = (db.seasons || {})[year];
      const integrity = assessSeasonWriteIntegrity(existing, candidate);
      if (integrity.destructive) blocked.push(`${year}: ${integrity.reasons.join('; ')}`);
    }
    if (blocked.length) {
      console.error(`[Save guard] BLOCKED destructive bulk season save: ${blocked.join(' | ')}`);
      addAuditEntry(db, 'seasons_save_all_blocked', { reasons: blocked }, req.get('X-User-Email'));
      writeDB(db);
      postSlack(
        `:no_entry: *Blocked a destructive bulk season save* (POST /api/seasons).\n• ${blocked.join('\n• ')}\nNo change was applied.`
      ).catch(() => {});
      return res.status(409).json({ error: 'destructive_bulk_save_blocked', reasons: blocked });
    }
  }

  const { force: _force, ...seasons } = incoming;
  // score_snapshots and daily rows are server-authoritative (see the per-year save) — carry each
  // stored season's copies through a bulk replace too, so even a forced replace can't blind the
  // swing guard or destroy the per-game stat history the weekly rebuild derives from.
  for (const [year, sdy] of Object.entries(seasons)) {
    const existing = (db.seasons || {})[year];
    if (existing && sdy && typeof sdy === 'object') {
      sdy.score_snapshots = existing.score_snapshots || [];
      sdy.daily_batting = existing.daily_batting || [];
      sdy.daily_pitching = existing.daily_pitching || [];
    }
  }
  addAuditEntry(db, 'seasons_save_all', { seasonCount: Object.keys(seasons).length }, req.get('X-User-Email'));
  db.seasons = seasons;
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

// GET /api/time — public server-clock check. Every activity timestamp in the app is
// stamped from this clock; compare `utc` against a trusted clock (a phone) to rule
// server clock skew in or out when a displayed time looks wrong.
app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({
    utc: now.toISOString(),
    eastern: now.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }),
    epoch_ms: now.getTime(),
  });
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

  const sd = req.body;
  const existingSd = (db.seasons || {})[req.params.year];

  // Optimistic-concurrency gate (SAVE_HARDENING_PLAN.md, Layer 1). The client must echo the `_rev`
  // it loaded from GET /api/seasons. If it's missing (a tab on old JS) or no longer matches the
  // server's current state (someone/something changed rosters/swaps/etc. since the client loaded),
  // the payload is a stale full-season snapshot — refuse it so it can't clobber newer state, and
  // make the client reload. A brand-new season (no existingSd) has nothing to clobber, so it's
  // allowed and seeds the first state. This closes the stale-overwrite class for ALL fields at once.
  if (existingSd) {
    const currentRev = computeSeasonRev(existingSd);
    if (sd._rev !== currentRev) {
      console.warn(
        `[Save gate] Rejected stale save for ${req.params.year} (client _rev=${sd._rev || 'none'} vs ${currentRev})`
      );
      return res.status(409).json({ error: 'stale_save', current_rev: currentRev });
    }
  }
  delete sd._rev; // transient token — never persist it onto the season

  addAuditEntry(db, 'season_save', { year: req.params.year }, req.get('X-User-Email'));

  // Stat records (daily_*/weekly_*) and team maps are server-authoritative — populated by the
  // MLB sync / backfill, never edited through this full-season save. A client that loaded
  // before a sync holds a stale, smaller copy; without this guard its saveSeason() silently
  // wipes the weeks the server fetched after the client loaded (the recurring "stats reset"
  // bug). Weekly rows: re-append any server record missing from the incoming payload (keyed per
  // week/player), mirroring the swap protection below; a client record with a matching key still
  // wins so commissioner CSV edits propagate. Daily rows: server copy wholesale (see below).
  if (existingSd) {
    const mergeStats = (incoming, existing, keyFn) => {
      const arr = Array.isArray(incoming) ? incoming : [];
      if (!Array.isArray(existing) || existing.length === 0) return arr;
      const have = new Set(arr.map(keyFn));
      for (const r of existing) if (!have.has(keyFn(r))) arr.push(r);
      return arr;
    };
    // Daily rows are fully server-authoritative — stronger than the weekly merge below. They are
    // written only server-side (MLB sync, the commissioner daily-stats endpoint, gated repairs)
    // and are no longer sent to clients at all (GET /api/seasons strips them), so there is no
    // legitimate client edit to honor. Taking the server copy wholesale also closes the
    // key-match regression vector the weekly merge still carries: a stale client's old copy of
    // a row can never again overwrite the server's fresher one (the 06-08 "scores froze" class).
    sd.daily_batting = existingSd.daily_batting || [];
    sd.daily_pitching = existingSd.daily_pitching || [];
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

    // The score-guard snapshot trail is server-authoritative: written only by
    // recordScoreSnapshot (4am sync, manual syncs, boot seeding) and no longer sent to clients
    // at all (GET /api/seasons strips it). Always keep the server's copy so a full-season save —
    // whether a slim new client or a snapshot-bearing stale one — can never wipe or roll back
    // the trail the swing guard diffs against. (SAVE_HARDENING_PLAN.md Layer 2.)
    sd.score_snapshots = existingSd.score_snapshots || [];

    // Playoff odds are a server-computed derived cache (4am sync / 7am post /
    // the recompute endpoint). Same defense as score_snapshots: always keep
    // the server's copy so a client save can never wipe or roll them back.
    if (existingSd.playoff_odds) sd.playoff_odds = existingSd.playoff_odds;

    // Elimination roasts are written server-side by /generate-roast while the client's
    // full-season save (fired at "End Pool Play") may still be in flight carrying a copy
    // that predates them — that save landing mid-generation is how a manager's roast
    // vanished from the first live combined post.
    //
    // The server's copy always wins, per manager. The client only ever READS sd.roasts
    // (three read sites in app.js, no writes), so a roast in an incoming payload is by
    // definition a stale echo of something the server wrote — never an edit. The previous
    // union-merge only filled in managers the payload didn't mention, which meant a save
    // carrying a pre-regeneration roast silently rolled that manager back: same manager,
    // older text, and any field added since (page_tables) quietly dropped.
    if (existingSd.roasts && typeof existingSd.roasts === 'object') {
      sd.roasts = { ...(sd.roasts && typeof sd.roasts === 'object' ? sd.roasts : {}), ...existingSd.roasts };
    }
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
  // Return the new concurrency token so the client can keep saving without a stale 409.
  res.json({ ok: true, _rev: computeSeasonRev(sd) });

  // Fire-and-forget Slack notifications for each new pending swap
  for (const swap of newPending) {
    postSlack(buildSwapSlackText(sd, swap, '*New Swap Request*')).catch(() => {});
  }
});

// --- Swap eligibility rules (mirror of js/swaps.js — keep the two copies identical; the server
// can't import the ESM js/ module, same as detectScoreSwings). Pool play: one Free Swap per PP
// round, unlimited IL/Drop/Trade. Playoffs: one of each type per round — one Free, one Drop, and
// one Trade — plus unlimited IL. Only pending and approved swaps consume a slot — denied and undone
// swaps refund it; commissioner adds/drops carry no `round` field and are excluded. ---
const FREE_SWAP_REASON = 'Free Swap (one per round)';
const PLAYOFF_LIMITED_REASONS = [FREE_SWAP_REASON, 'Drop Swap', 'Trade Swap'];

function checkSwapLimit(swaps, managerName, reason, round) {
  // Only count approved or pending swaps (not denied/undone) for this manager in this round
  const managerSwaps = (swaps || []).filter(
    (s) => s.manager === managerName && (s.status === 'approved' || s.status === 'pending') && s.round === round
  );

  // Pool Play: unlimited Drop/IL/Trade, but only 1 Free Swap per PP-round
  if (round === 'PP1' || round === 'PP2') {
    if (reason === FREE_SWAP_REASON) {
      const used = managerSwaps.filter((s) => s.reason === FREE_SWAP_REASON).length;
      if (used >= 1) {
        return `You have already used your Free Swap for ${round === 'PP1' ? 'Pool Play 1' : 'Pool Play 2'}. You may still use Drop, IL, or Trade swaps.`;
      }
    }
    return null; // Drop/IL/Trade unlimited during pool play
  }

  // Playoffs (QF, SF, Finals): IL swaps unlimited; one each of Free, Drop, and Trade per round
  if (round === 'QF' || round === 'SF' || round === 'Finals') {
    if (reason === 'IL Swap') return null;
    if (PLAYOFF_LIMITED_REASONS.includes(reason)) {
      const usedSwap = managerSwaps.find((s) => s.reason === reason);
      if (usedSwap) {
        const roundLabel = round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : 'the Finals';
        const swapLabel = reason === FREE_SWAP_REASON ? 'Free Swap' : reason;
        return `You have already used your ${swapLabel} for ${roundLabel} (on ${usedSwap.swap_date || 'an earlier date'}). You may still use your other playoff swaps or an IL swap.`;
      }
    }
    return null;
  }

  return null;
}

// Server port of the client's getCurrentScheduleRound: which schedule round contains today's ET
// date. Between weeks (e.g. the All-Star break or a round gap) it returns the UPCOMING round —
// that's the roster a swap made in the gap affects, so that's the round it's charged against.
// The server computes this itself at submission so the round can't be forged or go stale in an
// old client tab.
function currentScheduleRound(sd) {
  const dates = sd.schedule_dates;
  if (!dates || dates.length === 0) return { round: 'PP1', weekKey: null };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    const d = dates[i];
    if (d && today <= d.end) {
      return { round: SEASON_SCHEDULE[i].round, weekKey: `${SEASON_SCHEDULE[i].round}|${SEASON_SCHEDULE[i].week}` };
    }
  }
  // After the last week: use the final round.
  const last = SEASON_SCHEDULE[SEASON_SCHEDULE.length - 1];
  return { round: last.round, weekKey: `${last.round}|${last.week}` };
}

// Add days to an ISO YYYY-MM-DD date string (noon-UTC arithmetic — immune to DST edges).
function isoDateAddDays(iso, days) {
  return new Date(Date.parse(iso + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

// Last calendar day of a round (max schedule_dates end among the round's weeks), or null when
// the schedule doesn't cover it. Caps how far ahead a manager may schedule a swap: within the
// current round the existing date-window machinery is proven (commissioner approvals have always
// picked arbitrary in-round dates); across a period boundary rosters start fresh from a new
// submission, so a pre-scheduled swap there would violate the period-scoping invariant.
function scheduleRoundEndDate(sd, round) {
  const dates = sd.schedule_dates || [];
  let end = null;
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    if (SEASON_SCHEDULE[i].round === round && dates[i] && dates[i].end) {
      if (!end || dates[i].end > end) end = dates[i].end;
    }
  }
  return end;
}

// Server-side twin of the client's computeSwapEffectiveDates: a player whose team's game has
// already started today can't enter or leave a roster today, so the swap takes effect tomorrow
// (drop today, add tomorrow); otherwise it's effective today (drop yesterday, add today). The
// server recomputes this at submission rather than trusting the client's values. Falls back to
// "not started" when the MLB API is unreachable so swaps stay usable.
async function computeSwapEffectiveDatesServer(sd, playerOut, playerIn) {
  const teamOf = (name) =>
    (sd.batters_team && sd.batters_team[name]) || (sd.pitchers_team && sd.pitchers_team[name]) || null;
  const teams = [teamOf(playerOut), teamOf(playerIn)].filter(Boolean).map((t) => t.toUpperCase());

  const now = new Date();
  const isoET = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayStr = isoET(now);
  const yesterdayStr = isoET(new Date(now.getTime() - 86400000));
  const tomorrowStr = isoET(new Date(now.getTime() + 86400000));

  let started = [];
  if (teams.length) {
    try {
      const startedSet = await fetchStartedTeamsToday();
      started = teams.filter((t) => startedSet.has(t));
    } catch (e) {
      console.error('teams-started check failed during swap submission (treating as not started):', e.message);
    }
  }

  if (started.length) {
    return { effective_date: tomorrowStr, drop_date: todayStr, add_date: tomorrowStr, teams_started: started };
  }
  return { effective_date: todayStr, drop_date: yesterdayStr, add_date: todayStr, teams_started: [] };
}

// Public site URL used in Slack deep links (also hardcoded in the daily scoreboard post).
const WMMC_SITE_URL = 'http://wmmc.live';

// Slack text for a swap notification, mirroring the Swap Log's detail rows so the commissioner
// can read the whole transaction from the post: out/in with team abbreviations and their
// drop/add dates, reason + verified MLB IL status, round/week, effective date, submission time
// (ET), and a deep link to the Swap Log tab (#swap-log) for quick review/edit/undo.
function buildSwapSlackText(sd, swap, headline) {
  const teamOf = (name) =>
    (sd.batters_team && sd.batters_team[name]) || (sd.pitchers_team && sd.pitchers_team[name]) || null;
  const withTeam = (name) => {
    const t = teamOf(name);
    return t && !String(name).endsWith(`(${t})`) ? `${name} (${t})` : name;
  };
  const roundWeek = swap.week_key ? swap.week_key.replace('|', ' · ') : swap.round || '';
  // swap.timestamp is UTC ('YYYY-MM-DD HH:MM:SS' from toISOString) — render it in ET.
  const submittedET = swap.timestamp
    ? new Date(swap.timestamp.replace(' ', 'T') + 'Z').toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }) + ' ET'
    : '—';
  const unverifiedWhy =
    {
      no_mlb_id: 'no MLB id match for player',
      no_roster_entry: 'no current MLB roster entry',
      api_error: 'MLB API unreachable',
    }[swap.il_reason] || null;
  const ilNote =
    swap.il_status && swap.il_status !== 'unverified'
      ? ` (MLB status: ${swap.il_status})`
      : swap.il_status === 'unverified'
        ? ` (IL status unverified${unverifiedWhy ? ` — ${unverifiedWhy}` : ''})`
        : '';
  return [
    `${headline} — *${swap.manager || '?'}*${roundWeek ? ` (${roundWeek})` : ''}`,
    `*Out:* ${swap.player_out ? withTeam(swap.player_out) : '—'}${swap.drop_date ? ` — dropped ${swap.drop_date}` : ''}`,
    `*In:* ${swap.player_in ? withTeam(swap.player_in) : '—'}${swap.add_date ? ` — added ${swap.add_date}` : ''}`,
    `*Reason:* ${swap.reason || '—'}${ilNote}`,
    `*Effective:* ${swap.effective_date || swap.add_date || '—'} · *Submitted:* ${submittedET}`,
    `🔗 <${WMMC_SITE_URL}/#swap-log|Open the Swap Log to review, edit, or undo>`,
  ].join('\n');
}

// IL status codes on MLB roster entries: 7-day (concussion), 10-day, 15-day, and 60-day lists.
const MLB_IL_STATUS_CODES = new Set(['D7', 'D10', 'D15', 'D60']);

// Look up a player's official MLB roster status to verify an IL swap, then read the player's
// current roster entry. Identity comes from the stable MLB person id in sd.mlb_ids (the source
// of truth) when mapped; since ids are only pre-assigned for duplicate names and roster-fix
// runs, most rostered players have no stored id, so unmapped names fall back to a UNIQUE
// normalized-name match in the season's MLB player catalog. The fallback id is used only for
// this lookup — writing sd.mlb_ids stays a commissioner action (roster-fix), which keeps its
// duplicate-name ambiguity guards intact. Returns { checked: false, reason } when it can't
// verify (no id / no entry / API error) or { checked: true, onIL, status } when it can.
// Callers FAIL OPEN on checked:false — an MLB outage or an unresolvable name must never block
// a legitimate IL swap. Every fail path logs, since the caller only persists the reason code.
async function fetchPlayerILStatus(sd, season, playerName) {
  let mlbId = (sd.mlb_ids || {})[playerName];
  if (typeof mlbId !== 'number') {
    try {
      const catalog = await fetchMLBPlayerCatalog(season);
      const matches = indexCatalogByName(catalog).byNorm.get(normalizeName(playerName)) || [];
      if (matches.length === 1) mlbId = matches[0].id;
    } catch (e) {
      console.error(`IL status catalog fallback failed for ${playerName}:`, e.message);
    }
  }
  if (typeof mlbId !== 'number') {
    console.error(`IL status unverifiable for ${playerName}: no mapped id and no unique catalog name match`);
    return { checked: false, reason: 'no_mlb_id' };
  }
  try {
    const data = await mlbApiFetch(`/api/v1/people/${mlbId}?hydrate=rosterEntries`);
    const person = (data.people || [])[0];
    const entries = (person && person.rosterEntries) || [];
    // Current stint: prefer an explicitly active entry, else the newest open-ended one.
    const current =
      entries.find((e) => e.isActive === true) ||
      entries
        .filter((e) => !e.endDate)
        .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))[0] ||
      null;
    const status = current && current.status;
    if (!status || (!status.code && !status.description)) {
      console.error(`IL status unverifiable for ${playerName} (id ${mlbId}): no current roster entry status`);
      return { checked: false, reason: 'no_roster_entry' };
    }
    // Codes are the primary signal; live descriptions read "Injured 60-Day" (not
    // "60-Day Injured List"), and "Injured" appears only in IL statuses.
    const onIL = MLB_IL_STATUS_CODES.has(status.code) || /injured/i.test(status.description || '');
    return { checked: true, onIL, status: status.description || status.code };
  } catch (e) {
    console.error(`IL status lookup failed for ${playerName} (id ${mlbId}):`, e.message);
    return { checked: false, reason: 'api_error' };
  }
}

// POST /api/seasons/:year/swaps — submit a swap. Since the swap-automation change this
// AUTO-APPLIES: the server validates eligibility (per-round swap limits + official MLB IL status
// for IL swaps), computes the effective dates from the live schedule, and applies the swap
// immediately with the exact mutation the commissioner approve endpoint uses — no approval step.
// Safety valves preserved:
//   - the destructive-save integrity guard still runs; a flagged swap is NOT applied and instead
//     falls back to a pending request for commissioner review (the pre-automation flow);
//   - every applied swap lands in the swap log as approved, and the commissioner undo endpoint
//     reverses it exactly as before.
// Uses a tiny payload (just the swap object) instead of the full season JSON, so it cannot fail
// due to payload size and gives the client a clear success/error signal.
app.post('/api/seasons/:year/swaps', requireAuth, async (req, res) => {
  try {
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
    // Swaps auto-apply now, so identity matters: a manager can only submit swaps for their own
    // team (the commissioner can submit for anyone).
    if (!req.manager.commissioner && req.manager.name !== swap.manager) {
      return res.status(403).json({ error: 'You can only submit swaps for your own team.' });
    }
    const db = readDB();
    if (!db.seasons) db.seasons = {};
    const sd = (db.seasons || {})[req.params.year];
    if (!sd) return res.status(404).json({ error: 'Season not found' });
    if (sd.status !== 'active') return res.status(400).json({ error: 'Season is not active' });

    if (!Array.isArray(sd.swaps)) sd.swaps = [];

    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Idempotency guard: a double-click (or a retry while the first request was still in flight)
    // was creating two identical requests for the same manager + player_out + player_in — the
    // "commissioner got the same swap twice" bug. If an identical swap already exists (pending,
    // or applied today), return it instead of appending a duplicate (no second write, no second
    // Slack post, no double-applied roster windows).
    const dup = sd.swaps.find(
      (s) =>
        s.manager === swap.manager &&
        s.player_out === swap.player_out &&
        s.player_in === swap.player_in &&
        (s.status === 'pending' || (s.status === 'approved' && s.swap_date === todayET))
    );
    if (dup) {
      return res.json({ ok: true, swap: dup, duplicate: true, _rev: computeSeasonRev(sd) });
    }

    // The server, not the client, decides which round the swap belongs to and is charged against.
    const { round, weekKey } = currentScheduleRound(sd);
    swap.round = round;
    if (weekKey) swap.week_key = weekKey;

    // Eligibility: enforce the per-round swap limits server-side ("no longer eligible" swaps are
    // blocked with a warning, not queued). Commissioner Swaps bypass the limits — they are
    // corrections, not a manager's allotment.
    const isCommissionerSwap = swap.reason === 'Commissioner Swap' && req.manager.commissioner;
    if (!isCommissionerSwap) {
      const limitError = checkSwapLimit(sd.swaps, swap.manager, swap.reason, round);
      if (limitError) return res.status(400).json({ error: limitError, code: 'swap_limit' });
    }

    // IL swaps must be real: the player being dropped has to be on the official MLB injured list.
    // Verified against the MLB Stats API; unverifiable lookups fail open (il_status 'unverified',
    // with the reason kept on the swap so the Slack post says why instead of just "unverified").
    if (swap.reason === 'IL Swap') {
      const il = await fetchPlayerILStatus(sd, req.params.year, swap.player_out);
      if (il.checked && !il.onIL) {
        return res.status(400).json({
          error:
            `${swap.player_out} is not on the official MLB injured list` +
            `${il.status ? ` (current status: ${il.status})` : ''}. ` +
            `An IL swap requires the player you're dropping to be on the IL — use your Free, Drop, or Trade swap instead.`,
          code: 'not_on_il',
        });
      }
      if (il.checked) {
        swap.il_status = il.status;
      } else {
        swap.il_status = 'unverified';
        swap.il_reason = il.reason;
      }
    }

    // Server-computed effective dates (game-started rule), overriding the client's values —
    // unless the submitter scheduled the swap for a specific FUTURE effective date. Requesting
    // today is not scheduling: it means "apply now", so it falls through to the auto path, where
    // the players' teams' game start times decide whether the swap lands today or tomorrow.
    // Managers may only schedule FORWARD (no backdating, and no later than the current round's
    // end); the commissioner may pick any date, today included, as an explicit correction. A
    // scheduled date drives the same add/drop window shape as the auto path: drop the day
    // before, add on the date.
    const requestedEff = swap.requested_effective_date;
    delete swap.requested_effective_date;
    const isCommissioner = !!req.manager.commissioner;
    let scheduledEff = '';
    if (requestedEff !== undefined && requestedEff !== null && requestedEff !== '') {
      if (typeof requestedEff !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requestedEff)) {
        return res.status(400).json({ error: 'Invalid effective date (expected YYYY-MM-DD).' });
      }
      if (!isCommissioner) {
        if (requestedEff < todayET) {
          return res.status(400).json({
            error:
              'The effective date cannot be in the past — swaps cannot be backdated. ' +
              "Use today's date (or leave it blank) to apply the swap automatically.",
            code: 'effective_date_not_future',
          });
        }
        const roundEnd = scheduleRoundEndDate(sd, round);
        if (roundEnd && requestedEff > roundEnd) {
          return res.status(400).json({
            error: `The effective date can be no later than the end of the current round (${roundEnd}).`,
            code: 'effective_date_past_round',
          });
        }
      }
      if (requestedEff !== todayET || isCommissioner) scheduledEff = requestedEff;
    }
    if (scheduledEff) {
      swap.requested_effective_date = scheduledEff;
      swap.effective_date = scheduledEff;
      swap.add_date = scheduledEff;
      swap.drop_date = isoDateAddDays(scheduledEff, -1);
      swap.teams_started = [];
    } else {
      const eff = await computeSwapEffectiveDatesServer(sd, swap.player_out, swap.player_in);
      swap.effective_date = eff.effective_date;
      swap.drop_date = eff.drop_date;
      swap.add_date = eff.add_date;
      swap.teams_started = eff.teams_started;
    }
    swap.swap_date = todayET;

    // Server stamps id, timestamp, and status so the client cannot forge them.
    swap.id = Date.now().toString();
    swap.timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    swap.status = 'approved';
    swap.auto_approved = true;
    swap.reviewed_at = swap.timestamp;

    // Pristine copy for the before/after integrity vet (sd is mutated in place below).
    const originalSd = JSON.parse(JSON.stringify(sd));

    sd.swaps.push(swap);
    applySwapToSeason(sd, swap, swap.add_date, swap.drop_date);

    // Destructive-save guard: if applying this swap would crater a manager's total or shrink a
    // roster, do NOT auto-apply. Fall back to the pre-automation flow — queue it as a pending
    // request for the commissioner — instead of rejecting outright, so an unusual-but-legitimate
    // swap isn't lost.
    const integrity = assessSeasonWriteIntegrity(originalSd, sd);
    if (integrity.destructive) {
      db.seasons[req.params.year] = originalSd; // discard the applied mutation entirely
      const pendingSwap = { ...swap, status: 'pending' };
      delete pendingSwap.auto_approved;
      delete pendingSwap.reviewed_at;
      if (!Array.isArray(originalSd.swaps)) originalSd.swaps = [];
      originalSd.swaps.push(pendingSwap);
      addAuditEntry(
        db,
        'swap_auto_apply_blocked',
        { year: req.params.year, id: pendingSwap.id, manager: swap.manager, reasons: integrity.reasons },
        req.get('X-User-Email')
      );
      writeDB(db);
      res.json({
        ok: true,
        swap: pendingSwap,
        pending_review: true,
        reasons: integrity.reasons,
        _rev: computeSeasonRev(originalSd),
      });
      postSlack(
        buildSwapSlackText(
          originalSd,
          pendingSwap,
          `:warning: *Swap flagged (${req.params.year}) — pending your approval*`
        ) + `\n*Integrity guard:* ${integrity.reasons.join('; ')}`
      ).catch(() => {});
      return;
    }

    const before = captureScoreSnapshot(originalSd, todayET).totals;
    const after = captureScoreSnapshot(sd, todayET).totals;
    const totalsDelta = {};
    for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const d = ((after[m] || {}).total || 0) - ((before[m] || {}).total || 0);
      if (Math.abs(d) > 0.01) totalsDelta[m] = Math.round(d * 10) / 10;
    }

    db.seasons[req.params.year] = sd;
    addAuditEntry(
      db,
      'swap_auto_approved',
      {
        year: req.params.year,
        id: swap.id,
        manager: swap.manager,
        player_out: swap.player_out,
        player_in: swap.player_in,
        round,
        reason: swap.reason,
      },
      req.get('X-User-Email')
    );
    writeDB(db);
    // Return the new concurrency token: this write changed `swaps` (a hashed field), so a client
    // that follows up with a full-season save must adopt it or it would falsely 409 as stale.
    res.json({ ok: true, swap, totals_delta: totalsDelta, _rev: computeSeasonRev(sd) });

    postSlack(buildSwapSlackText(sd, swap, '*Swap Applied*')).catch(() => {});
  } catch (e) {
    console.error('Swap submission failed:', e);
    res.status(500).json({ error: 'Swap submission failed: ' + e.message });
  }
});

// Find a swap by id within a season, or null. Shared by the deny/edit/approve endpoints.
function findSwap(sd, swapId) {
  return (Array.isArray(sd.swaps) ? sd.swaps : []).find((s) => String(s.id) === String(swapId)) || null;
}

// POST /api/seasons/:year/swaps/:id/deny — atomically deny a pending swap. Deny touches no rosters,
// dates, or stats — it only flips status — so it carries zero scoring risk and is the safest of the
// swap-lifecycle endpoints. Replaces the client mutate + whole-season POST, whose stale-save 409
// could silently lose the denial and resurface the request. Part of #275 (ROSTER_OPS_PLAN.md §3a).
app.post('/api/seasons/:year/swaps/:id/deny', requireCommissioner, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  const swap = findSwap(sd, req.params.id);
  if (!swap) return res.status(404).json({ error: 'Swap not found' });
  if (swap.status !== 'pending') {
    return res.status(409).json({ error: 'swap_not_pending', detail: `Swap is ${swap.status}, not pending.` });
  }

  swap.status = 'denied';
  swap.reviewed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.seasons[req.params.year] = sd;
  addAuditEntry(
    db,
    'swap_denied',
    { year: req.params.year, manager: swap.manager, player_out: swap.player_out, player_in: swap.player_in },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, swap, _rev: computeSeasonRev(sd) });
});

// A swap is SCHEDULED while its add date has not arrived: nothing has actually moved yet — the
// incoming player is not on the roster and the outgoing player is still scoring — so the manager
// who submitted it can still change or cancel it themselves. The moment it takes effect the
// roster and the scoring windows are live and only the commissioner may touch it.
// Returns { status, body } to reject with, or null when the caller may proceed.
function swapModifyGuard(req, swap) {
  if (req.manager && req.manager.commissioner) return null; // commissioners are unrestricted
  if (!swap.manager || swap.manager !== (req.manager || {}).name) {
    return { status: 403, body: { error: 'You can only change your own swaps.', code: 'not_your_swap' } };
  }
  if (swap.status !== 'approved' && swap.status !== 'pending') {
    return {
      status: 409,
      body: { error: `This swap is ${swap.status} and can no longer be changed.`, code: 'swap_not_open' },
    };
  }
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const effective = swap.add_date || swap.effective_date || swap.requested_effective_date;
  if (!effective || effective <= todayET) {
    return {
      status: 403,
      body: {
        error: 'This swap has already taken effect — only the commissioner can change it now.',
        code: 'swap_already_effective',
      },
    };
  }
  return null;
}

// PUT /api/seasons/:year/swaps/:id — atomically patch a swap's own fields (player_out, player_in,
// reason, swap_date, effective_date, add_date, drop_date). Record-only edits (reason, players,
// swap_date) behave exactly as before: they edit the swap RECORD only and do not rebuild rosters.
// Changing add_date/drop_date on an APPROVED swap additionally re-applies the swap's roster
// windows with the new dates via applySwapToSeason (the same mutation approve/auto-apply use, so
// scoring is recomputed from the new windows immediately) and is vetted by the destructive-save
// integrity guard — a flagged edit is rejected (409, no write) unless { force: true }. Replaces
// the whole-season POST so an edit can't be lost to a stale 409 or clobber unrelated data.
// Part of #275 (ROSTER_OPS_PLAN.md §3b); date editing added with the scheduled-swaps change.
//
// Managers may also call this, but only for their own still-SCHEDULED swap (swapModifyGuard) and
// only for the two fields that are safe to change without re-running submission: the effective
// date and the reason. Changing the PLAYERS is commissioner-only — a player swap on a live record
// would leave the previous pair's roster windows behind, and the swap-limit/IL checks belong to
// the submission path — so a manager cancels and resubmits instead.
app.put('/api/seasons/:year/swaps/:id', requireAuth, async (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  const swap = findSwap(sd, req.params.id);
  if (!swap) return res.status(404).json({ error: 'Swap not found' });

  const {
    player_out: playerOut,
    player_in: playerIn,
    reason,
    swap_date: swapDate,
    effective_date: effectiveDate,
    add_date: addDate,
    drop_date: dropDate,
    force,
  } = req.body || {};
  const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  for (const [label, v] of [
    ['effective_date', effectiveDate],
    ['add_date', addDate],
    ['drop_date', dropDate],
  ]) {
    if (v !== undefined && v !== '' && !isISODate(v)) {
      return res.status(400).json({ error: `Invalid ${label} (expected YYYY-MM-DD).` });
    }
  }

  const isCommish = !!req.manager.commissioner;
  if (!isCommish) {
    const denied = swapModifyGuard(req, swap);
    if (denied) return res.status(denied.status).json(denied.body);
    if (playerOut !== undefined || playerIn !== undefined || swapDate !== undefined || force) {
      return res.status(403).json({
        error:
          'To change the players in a scheduled swap, cancel it and submit a new one — that re-checks your swap limits and IL status.',
        code: 'manager_field_not_editable',
      });
    }
    // Same rules the submission path enforces for a scheduled date: strictly forward (a date that
    // is today or earlier means "apply now", which is no longer a scheduled swap), and no later
    // than the end of the round — a new period starts fresh from its own submission.
    if (isISODate(addDate)) {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (addDate <= todayET) {
        return res.status(400).json({
          error:
            'A scheduled swap must stay in the future. To apply it right away, cancel it and submit a new swap with today as the effective date.',
          code: 'effective_date_not_future',
        });
      }
      const roundEnd = scheduleRoundEndDate(sd, swap.round || currentScheduleRound(sd).round);
      if (roundEnd && addDate > roundEnd) {
        return res.status(400).json({
          error: `The effective date can be no later than the end of the current round (${roundEnd}).`,
          code: 'effective_date_past_round',
        });
      }
    }
    // A reason change moves which allotment the swap spends, so re-run the same checks submission
    // does — with THIS swap excluded, so re-saving an unchanged reason can't collide with itself.
    if (typeof reason === 'string' && reason && reason !== swap.reason) {
      const others = (sd.swaps || []).filter((s) => String(s.id) !== String(swap.id));
      const limitError = checkSwapLimit(others, swap.manager, reason, swap.round);
      if (limitError) return res.status(400).json({ error: limitError, code: 'swap_limit' });
      if (reason === 'IL Swap') {
        const il = await fetchPlayerILStatus(sd, req.params.year, swap.player_out);
        if (il.checked && !il.onIL) {
          return res.status(400).json({
            error:
              `${swap.player_out} is not on the official MLB injured list` +
              `${il.status ? ` (current status: ${il.status})` : ''}. ` +
              `An IL swap requires the player you're dropping to be on the IL — use your Free, Drop, or Trade swap instead.`,
            code: 'not_on_il',
          });
        }
        swap.il_status = il.checked ? il.status : 'unverified';
        if (!il.checked) swap.il_reason = il.reason;
      }
    }
  }

  // Only an approved swap has live roster windows to move; pending swaps get their dates read at
  // approval time, so a record-only update suffices there.
  const scoringDatesChanged =
    (isISODate(addDate) && addDate !== swap.add_date) || (isISODate(dropDate) && dropDate !== swap.drop_date);
  const reapply = swap.status === 'approved' && scoringDatesChanged;
  // Pristine copy for the before/after integrity vet (sd is mutated in place below).
  const originalSd = reapply ? JSON.parse(JSON.stringify(sd)) : null;

  if (typeof playerOut === 'string' && playerOut) swap.player_out = playerOut;
  if (typeof playerIn === 'string' && playerIn) swap.player_in = playerIn;
  if (typeof reason === 'string') swap.reason = reason;
  if (typeof swapDate === 'string' && swapDate) swap.swap_date = swapDate;
  if (isISODate(addDate)) {
    swap.add_date = addDate;
    // effective_date is informational and equals the add date by construction — keep it in step
    // unless the caller sets it explicitly.
    if (effectiveDate === undefined) swap.effective_date = addDate;
  }
  if (isISODate(dropDate)) swap.drop_date = dropDate;
  if (isISODate(effectiveDate)) swap.effective_date = effectiveDate;
  // A manager sends only the effective (add) date; rebuild the canonical scheduled-swap window
  // shape the submission path produces — drop the day before, add on the date.
  if (!isCommish && isISODate(addDate)) {
    swap.drop_date = isoDateAddDays(addDate, -1);
    swap.effective_date = addDate;
    swap.requested_effective_date = addDate;
    swap.teams_started = [];
  }

  let totalsDelta;
  if (reapply) {
    applySwapToSeason(sd, swap, swap.add_date, swap.drop_date);

    const integrity = assessSeasonWriteIntegrity(originalSd, sd);
    if (integrity.destructive && !force) {
      // Discard the in-place mutation (sd IS db.seasons[year]); only the audit entry survives.
      db.seasons[req.params.year] = originalSd;
      addAuditEntry(
        db,
        'swap_edit_blocked',
        { year: req.params.year, id: swap.id, reasons: integrity.reasons },
        req.get('X-User-Email')
      );
      writeDB(db);
      // The commissioner can retry with { force }; a manager cannot, so tell them what to do next.
      return res.status(409).json({
        error: 'destructive_swap_edit_blocked',
        reasons: integrity.reasons,
        ...(isCommish
          ? {}
          : {
              detail: `This change would move scores (${integrity.reasons.join('; ')}). Ask the commissioner to make it.`,
            }),
      });
    }

    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const before = captureScoreSnapshot(originalSd, todayET).totals;
    const after = captureScoreSnapshot(sd, todayET).totals;
    totalsDelta = {};
    for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const d = ((after[m] || {}).total || 0) - ((before[m] || {}).total || 0);
      if (Math.abs(d) > 0.01) totalsDelta[m] = Math.round(d * 10) / 10;
    }
  }

  db.seasons[req.params.year] = sd;
  addAuditEntry(
    db,
    'swap_edited',
    {
      year: req.params.year,
      id: swap.id,
      manager: swap.manager,
      player_out: swap.player_out,
      player_in: swap.player_in,
      add_date: swap.add_date,
      drop_date: swap.drop_date,
      reapplied: !!reapply,
      forced: !!force,
      by_manager: !isCommish,
    },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, swap, ...(totalsDelta ? { totals_delta: totalsDelta } : {}), _rev: computeSeasonRev(sd) });
});

// Set the manager on a player's not-yet-attributed weekly rows. Server-side port of the client's
// assignUnclaimedStats (which has no server copy) — kept identical so the atomic approve below
// behaves exactly like the old client approveSwap, only without the stale-save 409 that lost it.
function assignUnclaimedStatsServer(sd, playerName, managerName, rosterType) {
  const isBatter = rosterType === 'batters' || rosterType === 'batting';
  const rows = isBatter ? sd.weekly_batting : sd.weekly_pitching;
  const key = isBatter ? 'batter' : 'pitcher';
  if (!Array.isArray(rows)) return;
  for (const r of rows) {
    if (r[key] === playerName && !r.manager) r.manager = managerName;
  }
}

// Apply an approved swap to a season in place: roster arrays out→in across the affected weeks,
// stat attribution for player_in, roster_dates drop/add windows (with the impossible-window drop
// clamp), then the same derived-state refresh the full-season save path runs (roster-array heal +
// player_dates cutoffs + weekly-score recompute). Without that refresh, the attribution credits
// player_in's already-synced weekly rows in full the moment the swap lands — even when add_date
// hasn't arrived yet (an IL swap effective tomorrow) — and the over-credit persists until the next
// sync happens to run; it also lets the caller's integrity vet compare the true resulting totals.
// Shared by the commissioner approve endpoint and the manager auto-apply submission path so the
// two can never drift. The caller stamps status/reviewed_at, runs the integrity vet, and persists.
function applySwapToSeason(sd, swap, effectiveAddDate, effectiveDropDate) {
  // --- faithful port of the client approveSwap mutation ---
  if (sd.rosters && sd.rosters[swap.manager]) {
    const mgrRoster = sd.rosters[swap.manager];
    let playerType = null;
    for (const weekRoster of Object.values(mgrRoster)) {
      if ((weekRoster.batters || []).includes(swap.player_out)) {
        playerType = 'batters';
        break;
      }
      if ((weekRoster.pitchers || []).includes(swap.player_out)) {
        playerType = 'pitchers';
        break;
      }
    }
    if (playerType) {
      const weekKeys = swap.week_key ? [swap.week_key] : Object.keys(mgrRoster);
      weekKeys.forEach((wk) => {
        const weekRoster = mgrRoster[wk];
        if (!weekRoster) return;
        const arr = weekRoster[playerType] || [];
        if (arr.includes(swap.player_out)) {
          weekRoster[playerType] = arr.filter((p) => p !== swap.player_out);
          if (!weekRoster[playerType].includes(swap.player_in)) weekRoster[playerType].push(swap.player_in);
        }
      });
      assignUnclaimedStatsServer(sd, swap.player_in, swap.manager, playerType);
    }
  }

  const rdWeekKeys = swap.week_key ? [swap.week_key] : Object.keys((sd.rosters && sd.rosters[swap.manager]) || {});
  if (!sd.roster_dates) sd.roster_dates = {};
  if (!sd.roster_dates[swap.manager]) sd.roster_dates[swap.manager] = {};
  // A player can't be dropped before they were added. If player_out was added earlier in this same
  // period (e.g. a rapid swap-then-undo where they were added today but the swap's canned drop date
  // is yesterday), a drop date before that add forms an impossible window (add after drop) that the
  // eligibility check reads as "still rostered" — so the drop silently never takes effect. Clamp the
  // drop up to the player's most recent in-period add. Dates are ISO 'YYYY-MM-DD' (lexicographic).
  const swapPeriodStart = periodStartForRound(sd, (swap.week_key || '').split('|')[0]);
  const latestInPeriodAdd = (player) => {
    let latest = null;
    for (const wkObj of Object.values(sd.roster_dates[swap.manager] || {})) {
      const e = wkObj && wkObj[player];
      if (e && e.add_date && (!swapPeriodStart || e.add_date >= swapPeriodStart) && (!latest || e.add_date > latest)) {
        latest = e.add_date;
      }
    }
    return latest;
  };
  const outAdd = swap.player_out ? latestInPeriodAdd(swap.player_out) : null;
  const clampedDropDate = outAdd && effectiveDropDate < outAdd ? outAdd : effectiveDropDate;
  rdWeekKeys.forEach((wk) => {
    if (!sd.roster_dates[swap.manager][wk]) sd.roster_dates[swap.manager][wk] = {};
    const wkDates = sd.roster_dates[swap.manager][wk];
    if (swap.player_out) {
      if (!wkDates[swap.player_out]) wkDates[swap.player_out] = {};
      wkDates[swap.player_out].drop_date = clampedDropDate;
    }
    if (swap.player_in) {
      if (!wkDates[swap.player_in]) wkDates[swap.player_in] = {};
      wkDates[swap.player_in].add_date = effectiveAddDate;
    }
  });
  // --- end port ---

  if (sd.status === 'active') {
    try {
      rebuildRosterArraysFromDates(sd);
    } catch (e) {
      console.error('[Roster array heal] Error (continuing):', e.message);
    }
  }
  if ((sd.daily_batting && sd.daily_batting.length) || (sd.daily_pitching && sd.daily_pitching.length)) {
    const wipedAuto = syncPlayerDatesFromRosterDates(sd);
    recomputeMidWeekAddScores(sd, wipedAuto);
  }
}

// POST /api/seasons/:year/swaps/:id/approve — atomically approve a pending swap. This is a faithful
// server-side port of the old client approveSwap (rosters out→in across the affected weeks +
// roster_dates drop/add windows + stat attribution), so scoring behavior is unchanged — but because
// it runs server-side under a read-modify-write, it can't be lost to a stale-save 409 (the
// "I approved it but it came back as pending" bug). Body: { add_date, drop_date, force? }. Before
// committing it runs the destructive-save integrity guard and, unless force is set, rejects (409,
// no write, Slack-alert) any approval that would crater a manager's total or shrink a roster.
// Part of #275 (ROSTER_OPS_PLAN.md §3c). Since the swap-automation change manager submissions
// auto-apply, so this endpoint mostly handles the integrity-guard fallback queue.
app.post('/api/seasons/:year/swaps/:id/approve', requireCommissioner, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  const swap = findSwap(sd, req.params.id);
  if (!swap) return res.status(404).json({ error: 'Swap not found' });
  if (swap.status !== 'pending') {
    return res.status(409).json({ error: 'swap_not_pending', detail: `Swap is ${swap.status}, not pending.` });
  }

  const { add_date: addDate, drop_date: dropDate, force } = req.body || {};
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const tomorrowET = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  })();
  const effectiveDropDate = (typeof dropDate === 'string' && dropDate) || swap.drop_date || todayET;
  const effectiveAddDate = (typeof addDate === 'string' && addDate) || swap.add_date || tomorrowET;

  // Pristine copy for the before/after integrity vet (sd is mutated in place below).
  const originalSd = JSON.parse(JSON.stringify(sd));

  swap.status = 'approved';
  swap.reviewed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  applySwapToSeason(sd, swap, effectiveAddDate, effectiveDropDate);

  // Before/after totals vet + destructive-save guard. A normal swap is net-zero on a week's roster
  // and shouldn't trip it; a flagged approval (e.g. dropping a high scorer) requires an explicit
  // force override so a legitimate large correction isn't blocked.
  const integrity = assessSeasonWriteIntegrity(originalSd, sd);
  if (integrity.destructive && !force) {
    // Discard the in-place mutation: sd IS db.seasons[year], so restore the pristine pre-approval
    // copy before writing, or writeDB would persist the very change we're blocking. Only the audit
    // entry is meant to survive.
    db.seasons[req.params.year] = originalSd;
    addAuditEntry(
      db,
      'swap_approve_blocked',
      { year: req.params.year, id: swap.id, reasons: integrity.reasons },
      req.get('X-User-Email')
    );
    writeDB(db); // persists the restored (good) season + the audit note; the blocked mutation is dropped
    postSlack(
      `:warning: *Swap approval blocked (${req.params.year})* — ${swap.manager}: out ${swap.player_out}, in ${swap.player_in}.\n• ` +
        `${integrity.reasons.join('\n• ')}\nRe-approve with force to apply.`
    ).catch(() => {});
    return res.status(409).json({ error: 'destructive_approve_blocked', reasons: integrity.reasons });
  }

  const before = captureScoreSnapshot(originalSd, todayET).totals;
  const after = captureScoreSnapshot(sd, todayET).totals;
  const totalsDelta = {};
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = ((after[m] || {}).total || 0) - ((before[m] || {}).total || 0);
    if (Math.abs(d) > 0.01) totalsDelta[m] = Math.round(d * 10) / 10;
  }

  db.seasons[req.params.year] = sd;
  addAuditEntry(
    db,
    'swap_approved',
    {
      year: req.params.year,
      id: swap.id,
      manager: swap.manager,
      player_out: swap.player_out,
      player_in: swap.player_in,
      forced: !!force,
    },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, swap, totals_delta: totalsDelta, _rev: computeSeasonRev(sd) });
});

// POST /api/seasons/:year/swaps/:id/undo — cleanly reverse an APPROVED swap (for mistakes / testing).
// Submitting a reverse swap stacks a SECOND set of add/drop windows and can leave an impossible date
// window (the bug that brought us here); undo instead erases the records this swap created — it
// removes player_in entirely (roster array + roster_dates window + stat attribution) and lifts the
// drop_date it stamped on player_out — restoring the roster to its pre-swap state with no residue.
// A revert can legitimately drop a manager's total (player_in's points go away), so it guards on a
// ≥40-pt crater and requires { force } to override. Part of #275.
//
// Open to the commissioner for any approved swap, and to a manager for their own still-SCHEDULED
// swap (swapModifyGuard) — cancelling before the effective date. Because nothing has taken effect
// yet, that cancel can't crater anything and a manager never gets the force override; if the guard
// somehow fires the swap is left alone and they're pointed at the commissioner.
app.post('/api/seasons/:year/swaps/:id/undo', requireAuth, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  const swap = findSwap(sd, req.params.id);
  if (!swap) return res.status(404).json({ error: 'Swap not found' });
  const isCommish = !!req.manager.commissioner;
  if (!isCommish) {
    const denied = swapModifyGuard(req, swap);
    if (denied) return res.status(denied.status).json(denied.body);
  }
  if (swap.status !== 'approved') {
    return res
      .status(409)
      .json({ error: 'swap_not_approved', detail: `Only an approved swap can be undone (this is ${swap.status}).` });
  }
  // A manager can never force past the crater guard — that override is the commissioner's call.
  const force = isCommish ? (req.body || {}).force : false;
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const originalSd = JSON.parse(JSON.stringify(sd));

  const rdWeekKeys = swap.week_key ? [swap.week_key] : Object.keys((sd.rosters && sd.rosters[swap.manager]) || {});

  // 1. Roster arrays: remove player_in, restore player_out (reverse of approve).
  if (sd.rosters && sd.rosters[swap.manager]) {
    const mgrRoster = sd.rosters[swap.manager];
    let playerType = null;
    for (const wr of Object.values(mgrRoster)) {
      if ((wr.batters || []).includes(swap.player_in) || (wr.batters || []).includes(swap.player_out)) {
        playerType = 'batters';
        break;
      }
      if ((wr.pitchers || []).includes(swap.player_in) || (wr.pitchers || []).includes(swap.player_out)) {
        playerType = 'pitchers';
        break;
      }
    }
    if (playerType) {
      rdWeekKeys.forEach((wk) => {
        const wr = mgrRoster[wk];
        if (!wr) return;
        const arr = wr[playerType] || [];
        wr[playerType] = arr.filter((p) => p !== swap.player_in);
        if (swap.player_out && !wr[playerType].includes(swap.player_out)) wr[playerType].push(swap.player_out);
      });
    }
  }

  // 2. roster_dates: erase player_in's window entirely; lift player_out's drop_date (re-activate).
  const mgrDates = (sd.roster_dates && sd.roster_dates[swap.manager]) || {};
  rdWeekKeys.forEach((wk) => {
    const wkDates = mgrDates[wk];
    if (!wkDates) return;
    if (swap.player_in) delete wkDates[swap.player_in];
    if (swap.player_out && wkDates[swap.player_out]) {
      delete wkDates[swap.player_out].drop_date;
      if (Object.keys(wkDates[swap.player_out]).length === 0) delete wkDates[swap.player_out];
    }
  });

  // 3. Stats: un-attribute player_in's weekly rows for this manager (inverse of approve's attribution).
  for (const r of sd.weekly_batting || []) {
    if (r.batter === swap.player_in && r.manager === swap.manager) r.manager = null;
  }
  for (const r of sd.weekly_pitching || []) {
    if (r.pitcher === swap.player_in && r.manager === swap.manager) r.manager = null;
  }

  // 4. Mark the swap undone (kept in the log for audit, not deleted).
  swap.status = 'undone';
  swap.undone_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // 5. Re-derive cutoffs + recompute, mirroring the approve endpoint / full-season save path:
  // wipes player_in's now-orphaned auto cutoff and restores any of player_out's weekly points the
  // lifted drop_date had zeroed, so the crater check below measures the true resulting totals.
  if (sd.status === 'active') {
    try {
      rebuildRosterArraysFromDates(sd);
    } catch (e) {
      console.error('[Roster array heal] Error (continuing):', e.message);
    }
  }
  if ((sd.daily_batting && sd.daily_batting.length) || (sd.daily_pitching && sd.daily_pitching.length)) {
    const wipedAuto = syncPlayerDatesFromRosterDates(sd);
    recomputeMidWeekAddScores(sd, wipedAuto);
  }

  // Guard: a revert legitimately reduces a total, so the full destructive-save guard (which would also
  // flag the expected approved-swap-count drop) isn't right here — check only for a ≥40-pt crater.
  const before = captureScoreSnapshot(originalSd, todayET).totals;
  const after = captureScoreSnapshot(sd, todayET).totals;
  const craters = [];
  for (const m of Object.keys(before)) {
    const b = (before[m] || {}).total || 0;
    const a = (after[m] || {}).total || 0;
    if (b - a >= 40) craters.push(`${m} total drops ${Math.round((b - a) * 10) / 10} (${b} → ${a})`);
  }
  if (craters.length && !force) {
    db.seasons[req.params.year] = originalSd; // discard the in-place revert; only the audit note survives
    addAuditEntry(
      db,
      'swap_undo_blocked',
      { year: req.params.year, id: swap.id, reasons: craters, by_manager: !isCommish },
      req.get('X-User-Email')
    );
    writeDB(db);
    postSlack(
      `:warning: *Swap undo blocked (${req.params.year})* — ${swap.manager}: removing ${swap.player_in}, restoring ${swap.player_out}.\n• ` +
        `${craters.join('\n• ')}\nRe-run with force to apply.`
    ).catch(() => {});
    // A manager has no force override — a scheduled cancel shouldn't be able to trip this at all,
    // so if it does, something is off and the commissioner needs to look at it.
    return res.status(409).json({
      error: 'destructive_undo_blocked',
      reasons: craters,
      ...(isCommish ? {} : { detail: 'Cancelling this swap would change scores. Ask the commissioner to undo it.' }),
    });
  }

  db.seasons[req.params.year] = sd;
  addAuditEntry(
    db,
    'swap_undone',
    {
      year: req.params.year,
      id: swap.id,
      manager: swap.manager,
      player_out: swap.player_out,
      player_in: swap.player_in,
      forced: !!force,
      by_manager: !isCommish,
    },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, swap, _rev: computeSeasonRev(sd) });
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
  // Changed a submission bucket (a hashed field) — hand back the new token so a following
  // full-season save doesn't falsely 409.
  res.json({ ok: true, submission, _rev: computeSeasonRev(sd) });
});

// PUT /api/seasons/:year/schedule — atomically set the per-week schedule_dates (and the optional
// ASG date / period deadlines computed alongside it in Season Setup) WITHOUT a whole-season
// overwrite. schedule_dates defines every add/drop scoring window (the core invariant), so this is
// commissioner-only, validates the shape, and refuses to SHRINK an existing schedule — an incomplete
// schedule silently turns every `add_date <= weekEnd` check into "always eligible" and corrupts
// scoring league-wide (the exact wipe the per-field save guard was added to catch). First slice of
// the granular-endpoints migration (#275): peels the schedule off the clobber-prone full-season POST.
app.put('/api/seasons/:year/schedule', requireCommissioner, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const { schedule_dates: scheduleDates, asg_date: asgDate, period_deadlines: periodDeadlines } = req.body || {};
  if (!Array.isArray(scheduleDates) || scheduleDates.length === 0) {
    return res.status(400).json({ error: 'schedule_dates[] is required' });
  }
  const wellFormed = scheduleDates.every(
    (w) => w && typeof w === 'object' && typeof w.start === 'string' && typeof w.end === 'string'
  );
  if (!wellFormed) {
    return res.status(400).json({ error: 'each schedule_dates entry needs string start and end fields' });
  }

  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  // Refuse a schedule that drops weeks vs the stored one — protects every add/drop scoring window.
  const storedLen = Array.isArray(sd.schedule_dates) ? sd.schedule_dates.length : 0;
  if (scheduleDates.length < storedLen) {
    return res.status(409).json({
      error: 'schedule_would_shrink',
      detail: `Refusing to replace ${storedLen} stored weeks with ${scheduleDates.length}.`,
    });
  }

  sd.schedule_dates = scheduleDates;
  if (typeof asgDate === 'string') sd.asg_date = asgDate;
  if (periodDeadlines && typeof periodDeadlines === 'object') {
    if (!sd.period_deadlines) sd.period_deadlines = {};
    Object.assign(sd.period_deadlines, periodDeadlines);
  }

  db.seasons[req.params.year] = sd;
  addAuditEntry(
    db,
    'schedule_saved',
    { year: req.params.year, weeks: scheduleDates.length, asg_date: sd.asg_date || null },
    req.get('X-User-Email')
  );
  writeDB(db);
  // schedule_dates is a hashed field — return the new token so a following full-season save from the
  // same client doesn't falsely 409.
  res.json({ ok: true, schedule_dates: sd.schedule_dates, _rev: computeSeasonRev(sd) });
});

// PUT /api/seasons/:year/pool — atomically write one player pool (batters or pitchers) + its team map
// from a commissioner CSV upload, instead of riding the whole-season POST. The client still does the
// CSV merge (mergePlayerPool: same-name/team collisions + renames); this just writes the result under
// a server read-modify-write. Pool uploads are additive (adds/renames), so a payload that would SHRINK
// the stored pool signals a stale/bad upload and is refused — the same protection as the schedule
// endpoint, letting the per-field merge band-aid stay as defense-in-depth. Last slice of #275.
app.put('/api/seasons/:year/pool', requireCommissioner, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const { type, pool, team_map: teamMap } = req.body || {};
  if (type !== 'batters' && type !== 'pitchers') {
    return res.status(400).json({ error: "type must be 'batters' or 'pitchers'" });
  }
  if (!Array.isArray(pool) || !pool.every((p) => typeof p === 'string')) {
    return res.status(400).json({ error: 'pool must be an array of player-name strings' });
  }

  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  const poolKey = type === 'batters' ? 'batters_pool' : 'pitchers_pool';
  const teamKey = type === 'batters' ? 'batters_team' : 'pitchers_team';

  // Refuse a pool that shrinks vs the stored one — uploads only add/rename, never wipe.
  const storedLen = Array.isArray(sd[poolKey]) ? sd[poolKey].length : 0;
  if (pool.length < storedLen) {
    return res.status(409).json({
      error: 'pool_would_shrink',
      detail: `Refusing to replace ${storedLen} stored ${type} with ${pool.length}.`,
    });
  }

  sd[poolKey] = pool;
  if (teamMap && typeof teamMap === 'object' && !Array.isArray(teamMap)) sd[teamKey] = teamMap;

  db.seasons[req.params.year] = sd;
  addAuditEntry(db, 'pool_uploaded', { year: req.params.year, type, count: pool.length }, req.get('X-User-Email'));
  writeDB(db);
  // The pool is a hashed field — return the new token so a following full-season save isn't stale.
  res.json({ ok: true, type, count: pool.length, _rev: computeSeasonRev(sd) });
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
  res.json({ ok: true, removed, _rev: computeSeasonRev(sd) });
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
  res.json({ ok: true, _rev: computeSeasonRev(sd) });
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
// DB backup / restore (commissioner-only)
// ============================================================
//
// The server already WRITES rolling dated backups (wmmc_db_bak_<YYYY-MM-DD>, ~14-day TTL) on every
// boot/save. These two endpoints make them usable in-app so recovery from a bad write no longer
// means opening the Upstash console. Restore is destructive, so it is gated three ways: commissioner
// auth, an explicit confirm token that must echo the chosen date, and a fresh pre-restore backup of
// the current live state taken (and awaited) BEFORE anything is overwritten.

// GET /api/admin/db-backups — probe the last ~14 days of dated snapshots and report which exist,
// each with a one-glance integrity summary (last_saved_at + per-season schedule_dates length).
app.get('/api/admin/db-backups', requireCommissioner, async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(503).json({ error: 'backups_unavailable', detail: 'Upstash is not configured on this deploy.' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 30);
  // Build the candidate date keys (today back N-1 days), then probe them concurrently.
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  const snapshots = await Promise.all(dateKeys.map((d) => loadTimestampedBackup(d)));
  const backups = dateKeys.map((date, i) => {
    const snap = snapshots[i];
    return snap ? { date, exists: true, ...summarizeBackup(snap) } : { date, exists: false };
  });
  res.json({ backups, live: summarizeBackup(readDB()) });
});

// POST /api/admin/db-restore?date=YYYY-MM-DD — restore a dated snapshot to live.
// Body: { confirm: "YYYY-MM-DD" } must match the date query param (a deliberate, non-accidental
// confirmation). The current live DB is backed up first (awaited) so a restore is itself reversible.
app.post('/api/admin/db-restore', requireCommissioner, async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(503).json({ error: 'backups_unavailable', detail: 'Upstash is not configured on this deploy.' });
  }
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid_date', detail: 'date query param must be YYYY-MM-DD.' });
  }
  const confirm = req.body && req.body.confirm;
  if (confirm !== date) {
    return res
      .status(400)
      .json({ error: 'confirmation_required', detail: 'Body { confirm } must echo the date being restored.' });
  }

  const snapshot = await loadTimestampedBackup(date);
  if (!snapshot) {
    return res.status(404).json({ error: 'backup_not_found', detail: `No backup exists for ${date}.` });
  }
  // Structural sanity: a restore must look like a real DB, never an empty/garbage blob.
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.seasons !== 'object') {
    return res.status(422).json({ error: 'backup_corrupt', detail: `Backup for ${date} is missing a seasons object.` });
  }

  // Snapshot the CURRENT live state under a distinct pre-restore key (kept the full 14 days) BEFORE
  // overwriting, so an unwanted restore can itself be rolled back. Await it — durability first.
  const live = readDB();
  const preKey = `${UPSTASH_KEY}_bak_prerestore_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const preBackup = await saveBackupKey(live, preKey);
  if (!preBackup.ok && !preBackup.skipped) {
    return res
      .status(502)
      .json({ error: 'pre_restore_backup_failed', detail: 'Aborted: could not back up current state.' });
  }

  // Backups are slim (daily_batting/daily_pitching are stripped to fit Upstash — see slimForBackup),
  // so a restore brings back standings immediately but not per-game daily detail. Flag any active
  // season whose daily rows are empty so the commissioner knows to re-run the MLB backfill.
  const needsBackfill = Object.entries(snapshot.seasons || {})
    .filter(
      ([, sd]) =>
        sd &&
        sd.status === 'active' &&
        !((sd.daily_batting && sd.daily_batting.length) || (sd.daily_pitching && sd.daily_pitching.length))
    )
    .map(([year]) => year);

  // Commit the restored snapshot to live (disk + Upstash). awaitBackup so the restore can't be lost
  // if the instance spins down immediately after. Stamp the audit log on the restored DB.
  addAuditEntry(snapshot, 'db_restore', { date, pre_restore_key: preKey }, req.get('X-User-Email'));
  await writeDB(snapshot, { awaitBackup: true });
  console.log(`[Restore] Commissioner restored DB snapshot ${date} (pre-restore backup: ${preKey}).`);
  const backfillNote = needsBackfill.length
    ? ` Per-game daily detail for ${needsBackfill.join(', ')} was not in the slim backup — run an MLB backfill (POST /api/mlb/backfill) to repopulate it.`
    : '';
  try {
    await postSlack(
      `:leftwards_arrow_with_hook: *WMMC DB restored* to the ${date} snapshot by ${req.get('X-User-Email')}. ` +
        `Previous state saved as \`${preKey}\`.${backfillNote}`
    );
  } catch (e) {
    console.error('[Restore] Slack alert failed:', e.message);
  }
  res.json({
    ok: true,
    restored: date,
    pre_restore_key: preKey,
    summary: summarizeBackup(snapshot),
    backfill_needed: needsBackfill,
    note: backfillNote.trim() || undefined,
  });
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
  const fields = ['1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb', 'abs', 'so', 'lob'];
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

// Points a player has ALREADY been certified for on `date`, read from the stored daily rows
// the nightly sync wrote. The weekly totals the Scoreboard shows are rebuilt from these rows
// (see rebuildWeeklyFromDaily), so this is exactly the slice of a manager's certified total
// that `date` contributes.
//
// The Live tab needs this to avoid double-counting: it adds the live MLB numbers for the day
// on screen on top of the certified scoreboard, and once the 4am sync has folded that day in,
// those points are in BOTH halves of the sum. Subtracting this leaves only the not-yet-certified
// remainder, so Live == Scoreboard in the morning window between slates.
function certifiedDailyScoreForDate(sd, playerName, playerType, round, week, date) {
  const isBatting = playerType === 'batting';
  const rows = ((isBatting ? sd.daily_batting : sd.daily_pitching) || []).filter(
    (r) => r[isBatting ? 'batter' : 'pitcher'] === playerName && r.round === round && r.week === week && r.date === date
  );
  if (rows.length === 0) return 0;
  const total = rows.reduce(
    (sum, r) => sum + (isBatting ? calculateBattingScore(r.delta || {}) : calculatePitchingScore(r.delta || {})),
    0
  );
  return Math.round(total * 100) / 100;
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

// Version stamp — mirrors app.js ROSTER_REPAIR_VERSION.  Bump both together.
// v6: carry-forward now folds swaps effective in a trusted seed week into the
// baseline, so an in-season move made during the first week propagates forward.
// v7: carry-forward no longer crosses period (round) boundaries — a new period
// (PP2/QF/SF/Finals) starts fresh from its own submission, never the prior period's
// Week-5 roster (previously the boundary week was re-filled from carry-forward).
const ROSTER_REPAIR_VERSION = 7;

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

        // A new scoring period starts fresh from its own submission — never carry the prior
        // period's roster across a period (round) boundary (PP2/QF/SF/Finals Week 1). Reset the
        // carry-forward baseline so the boundary week is owned by its submission, not by the
        // previous period's Week-5 holdovers. (Mirrors the boundary skips already in the Sunday
        // auto-advance and managerWeekSubtotal's period-scoped eligibility.)
        if (i > 0 && SEASON_SCHEDULE[i].round !== SEASON_SCHEDULE[i - 1].round) {
          prevBatters = null;
          prevPitchers = null;
        }

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

// Split a contested week's rows per manager. A weekly row is stored once per player per week, but
// a player can be held by two managers inside one week (a mid-week trade or waiver pickup: dropped
// by A on the 28th, added by B on the 29th). The row's weekly_score then covers the merged window —
// everyone's days — and the sticky `manager` field names only one of them, so any consumer that
// reads either one credits the wrong manager. `manager_scores` records what each owner actually
// earned inside HIS OWN window, so the server and the client (which is not sent daily rows, and so
// cannot re-derive this) agree on the split. Written only for genuinely contested players; removed
// again as soon as a week has a single owner, so the normal case carries no extra state.
function applyManagerScoreSplits(sd, round, week) {
  const weekKey = `${round}|${week}`;
  const weekIdx = getScheduleWeekIndex(round, week);
  const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;

  const ownersOf = (player, listKey) => {
    const owners = new Map(); // manager -> that manager's roster_dates entry for this week (or null)
    for (const [mgr, weeks] of Object.entries(sd.roster_dates || {})) {
      const entry = ((weeks || {})[weekKey] || {})[player];
      if (entry) owners.set(mgr, entry);
    }
    for (const [mgr, weeks] of Object.entries(sd.rosters || {})) {
      const arr = ((weeks || {})[weekKey] || {})[listKey] || [];
      if (arr.includes(player) && !owners.has(mgr)) owners.set(mgr, null);
    }
    return owners;
  };

  const split = (rows, playerKey, listKey, dailyRows, scoreOf) => {
    for (const row of rows) {
      if (row.round !== round || row.week !== week) continue;
      const owners = ownersOf(row[playerKey], listKey);
      if (owners.size < 2) {
        delete row.manager_scores;
        continue;
      }
      const records = (dailyRows || []).filter(
        (r) => r[playerKey] === row[playerKey] && r.round === round && r.week === week
      );
      if (records.length === 0) {
        delete row.manager_scores;
        continue;
      }
      const scores = {};
      for (const [mgr, entry] of owners) {
        const w = managerWeekWindowServer(entry, weekDates);
        const total = records
          .filter((r) => !w || ((!w.start || r.date >= w.start) && (!w.end || r.date <= w.end)))
          .reduce((sum, r) => sum + scoreOf(r.delta || {}), 0);
        scores[mgr] = Math.round(total * 100) / 100;
      }
      row.manager_scores = scores;
    }
  };

  split(sd.weekly_batting || [], 'batter', 'batters', sd.daily_batting, calculateBattingScore);
  split(sd.weekly_pitching || [], 'pitcher', 'pitchers', sd.daily_pitching, calculatePitchingScore);
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
    if (!batMap[r.batter]) {
      batMap[r.batter] = { '1b': 0, '2b': 0, '3b': 0, hr: 0, r: 0, rbi: 0, sb: 0, bb: 0, abs: 0, so: 0, lob: 0 };
    }
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

  applyManagerScoreSplits(sd, round, week);
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

// One-shot maintenance: re-derive QS on existing pitching records using the WMMC rule, then
// resync player_dates and recompute every weekly_score so the corrected values reach My Roster,
// the scoreboard and the Live tab without waiting for the next 4am sync. Manual commissioner
// overrides (manual_fields=qs or drop_locked) are left intact.
//
// Gated by a db flag, like every sibling migration above. It is idempotent, but it is NOT cheap:
// recomputeAllWeeklyScores rescans the whole daily array once per weekly row, which is ~7-13s of
// synchronous, event-loop-blocking work at this league's row counts — paid on every boot (so on
// every Render deploy and every spin-down wake) to redo work that cannot have changed. A later
// full recompute is still available on demand via POST /api/seasons/:year/recompute-scores.
function backfillWmmcQS(db) {
  if (!db || db.wmmc_qs_backfill_done) return false;

  let dailyTouched = 0;
  let weeklyTouched = 0;
  for (const sd of Object.values(db.seasons || {})) {
    if (!sd) continue;
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
  db.wmmc_qs_backfill_done = true;
  if (dailyTouched > 0 || weeklyTouched > 0) {
    console.log(`[WMMC-QS] Backfill: corrected ${dailyTouched} daily delta(s), ${weeklyTouched} weekly row(s)`);
  }
  return true;
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

// Which round a Slack scoreboard post for this season covers, or null when this process
// cannot tell. THE single source of truth for that question: `buildScoreboardBlocks` frames
// the post from it, and `hasScoreboardData` / `postScoreboardSlack` gate on it, so the
// pre-flight check and the post that actually goes out can never disagree.
//
// Returning null is the "say nothing" signal. Every caller must treat it that way, because
// a null round is exactly the state that renders the pool-play shell — "Current Period:
// *Season*", the Overall Standings + pool columns, "_No scores recorded yet._" — which is
// never right, and is at its most wrong in the middle of the playoffs.
function resolveScoreboardRound(sd) {
  if (!sd) return null;

  // The calendar is the real answer whenever it is readable: today's week, else the most
  // recently completed one.
  const fromSchedule = detectCurrentRound(sd.schedule_dates || []);
  if (fromSchedule) return fromSchedule;

  // No usable schedule_dates. Fall back to the latest round this season has any stat rows
  // for — that covers the gsheets-era historical seasons, which carry scores but no stored
  // schedule. Both stat tables count: a batting-only fallback left a season whose pitching
  // rows restored first with no round at all, i.e. the shell.
  const roundsWithData = new Set([
    ...(sd.weekly_batting || []).map((r) => r.round),
    ...(sd.weekly_pitching || []).map((r) => r.round),
  ]);
  let fromData = null;
  for (let i = ROUND_ORDER.length - 1; i >= 0; i--) {
    if (roundsWithData.has(ROUND_ORDER[i])) {
      fromData = ROUND_ORDER[i];
      break;
    }
  }
  if (!fromData) return null;

  // ...but not if the bracket is already locked and pool play is all this process can see.
  // Pool play is over, so the pool-play frames would be reporting a finished phase as if it
  // were live; and with no calendar we cannot say which playoff round we are actually in.
  // Report nothing rather than the wrong thing. (An explicit PP2 wrap-up post is unaffected:
  // `opts.summaryRound` names the round directly and never comes through here.)
  const bracketLocked = !!(
    sd.confirmed_seeding &&
    Array.isArray(sd.confirmed_seeding.qualifierNames) &&
    sd.confirmed_seeding.qualifierNames.length > 0
  );
  if (bracketLocked && (fromData === 'PP1' || fromData === 'PP2')) return null;

  return fromData;
}

// Per-week subtotal for one manager. Mirrors app.js' managerWeekSubtotal
// exactly so the Slack scoreboard and Live tab totals reconcile to the
// in-app My Roster page (wasDroppedBefore filter -> eligibility set ->
// manager/null dedup -> sum of weekly_score).
// `detailOut` (optional): when provided, each eligible player row that
// contributes to the subtotal is pushed as { player, score } — used by the
// daily score-snapshot trail to record per-player breakdowns without changing
// the numeric return value the other callers rely on.
// What ONE manager earned from ONE weekly stat row. Normally that is the row's stored
// weekly_score. It is not when the player changed hands inside the week: a week's scoring window is
// stored once per player (player_dates), not once per owner, so the row a mid-week trade leaves
// behind is the sum for BOTH managers over the merged window — crediting it whole to either one is
// wrong in both directions. When this manager's own add/drop dates cover only part of the week, sum
// the daily rows inside HIS window instead. Both bounds inclusive: add_date is the first day he
// scores, drop_date the last (the effective-tomorrow swap shape — drop today, add tomorrow — exists
// precisely so the outgoing player keeps the day his team already played).
//
// Deliberate commissioner values always win: a drop_locked / manual_fields row, or a hand-set
// (non-auto) player_dates entry, keeps its stored number. So does a week with no daily rows for the
// player (gsheets-era weeks), where there is nothing to re-derive from.
function managerRowScoreForWeek(sd, row, playerKey, managerName, weekKey, weekDates, ownDates) {
  const stored = row.weekly_score || 0;
  // A contested week carries the split the compile already worked out (applyManagerScoreSplits).
  if (row.manager_scores && Object.prototype.hasOwnProperty.call(row.manager_scores, managerName)) {
    return row.manager_scores[managerName] || 0;
  }
  const window = managerWeekWindowServer(ownDates, weekDates);
  if (!window) return stored;
  if (row.drop_locked || (row.manual_fields && row.manual_fields.length > 0)) return stored;
  const override = (((sd.player_dates || {})[weekKey] || {})[playerKey] || {})[row[playerKey]];
  if (override && !override.auto) return stored;

  const isBatting = playerKey === 'batter';
  const records = ((isBatting ? sd.daily_batting : sd.daily_pitching) || []).filter(
    (r) => r[playerKey] === row[playerKey] && r.round === row.round && r.week === row.week
  );
  if (records.length === 0) return stored;

  const inWindow = records.filter(
    (r) => (!window.start || r.date >= window.start) && (!window.end || r.date <= window.end)
  );
  const total = inWindow.reduce(
    (sum, r) => sum + (isBatting ? calculateBattingScore(r.delta || {}) : calculatePitchingScore(r.delta || {})),
    0
  );
  return Math.round(total * 100) / 100;
}

// The slice of a week one manager held a player, or null when he held him for the whole week.
// Mirrors managerWeekWindow in js/eligibility.js — keep the two copies identical.
function managerWeekWindowServer(dates, weekDates) {
  if (!dates) return null;
  const weekStart = (weekDates && weekDates.start) || null;
  const weekEnd = (weekDates && weekDates.end) || null;
  const start = dates.add_date && (!weekStart || dates.add_date > weekStart) ? dates.add_date : null;
  const end = dates.drop_date && (!weekEnd || dates.drop_date < weekEnd) ? dates.drop_date : null;
  return start || end ? { start, end } : null;
}

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
    if (!matchesRoundWeek(r) || r.manager === managerName) return;
    // Unattributed rows are claimed by eligibility, as before. A row attributed to ANOTHER manager
    // is claimed too when this manager has his own add/drop window for that player THIS week — the
    // mid-week handover. `manager` is a sticky derived cache (the sync stamps whoever holds the
    // player at compile time), so it cannot arbitrate a player who changed hands inside the week;
    // the date windows can, and managerRowScoreForWeek gives each side only its own days.
    const contested = !!(r.manager_scores && Object.prototype.hasOwnProperty.call(r.manager_scores, managerName));
    if (r.manager && !weekRosterDates[r[playerKey]] && !contested) return;
    if (!eligible.has(r[playerKey]) || allWeekRows.some((x) => x[playerKey] === r[playerKey])) return;
    allWeekRows.push(r);
  });

  const finalRows = allWeekRows.filter((r) => eligible.has(r[playerKey]));
  const rowScore = (r) =>
    managerRowScoreForWeek(
      sd,
      r,
      playerKey,
      managerName,
      weekKey,
      scheduleDates[weekIdx],
      weekRosterDates[r[playerKey]]
    );
  if (detailOut) {
    for (const r of finalRows) detailOut.push({ player: r[playerKey], score: rowScore(r) });
  }
  return finalRows.reduce((s, r) => s + rowScore(r), 0);
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
const r2s = (n) => Math.round(n * 100) / 100;

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

// ============================================================
// Weekly-rollup drift audit
// ============================================================
// Certified totals are summed from the weekly_* rollup rows. Those rows are a DERIVED CACHE of the
// daily rows plus each manager's add/drop windows — and on 2026-07-29 the cache and its source
// disagreed for three hours with nothing noticing: a manager's certified QF week scored 0 while the
// stored row (and the daily record behind it) both said 37.35, so the 7am post went out 37.35
// light. Every guard in the file compares a total against ANOTHER total — the swing guard against
// yesterday's, the save guard against the stored one — so a rollup that quietly stops matching the
// stats underneath it is invisible to all of them. This recomputes each manager's week straight
// from the daily rows inside their own roster windows and reports where the rollup disagrees.
//
// Detection only — it never mutates the season. Commissioner overrides are excluded rather than
// flagged: a drop_locked / manual_fields row is a deliberate hand-set number that is SUPPOSED to
// differ from the daily rows.

// Which players a manager rostered during one week, and the slice of that week they were his.
// Derived from roster_dates alone (period-scoped, both bounds inclusive) — deliberately NOT from
// the weekly rows or their sticky `manager` field, since those are the cache being audited. Falls
// back to the week's roster array only for players with no date events at all (an initial
// submission that predates roster_dates).
function managerWeekRosterWindows(sd, manager, round, week, weekIdx) {
  const weekDates = (sd.schedule_dates || [])[weekIdx] || {};
  const weekStart = weekDates.start || null;
  const weekEnd = weekDates.end || null;
  if (!weekStart || !weekEnd) return {};

  const periodStart = periodStartForRound(sd, round);
  const mgrDates = (sd.roster_dates || {})[manager] || {};
  const latestAdd = {};
  const latestDrop = {};
  // Players whose add lands AFTER this week. An effective-tomorrow swap submitted on a week's final
  // day stamps add_date = the NEXT week's first day, and files the entry under the week it was
  // submitted in — so the date is out of range for latestAdd below while sitting in this week's
  // bucket, and the incoming player is already in this week's roster array. That date is positive
  // evidence he was not yet rostered here (the certified path reads it directly and scores him 0),
  // so he must not reach the roster-array fallback and be credited a week he never played.
  const joinedAfterWeek = new Set();
  for (const players of Object.values(mgrDates)) {
    for (const [p, d] of Object.entries(players || {})) {
      if (!d) continue;
      if (d.add_date && (!periodStart || d.add_date >= periodStart) && d.add_date > weekEnd) {
        joinedAfterWeek.add(p);
      }
      if (
        d.add_date &&
        (!periodStart || d.add_date >= periodStart) &&
        d.add_date <= weekEnd &&
        (!latestAdd[p] || d.add_date > latestAdd[p])
      ) {
        latestAdd[p] = d.add_date;
      }
      if (
        d.drop_date &&
        (!periodStart || d.drop_date >= periodStart) &&
        d.drop_date <= weekEnd &&
        (!latestDrop[p] || d.drop_date > latestDrop[p])
      ) {
        latestDrop[p] = d.drop_date;
      }
    }
  }

  const windows = {};
  for (const p of new Set([...Object.keys(latestAdd), ...Object.keys(latestDrop)])) {
    const add = latestAdd[p] || null;
    const drop = latestDrop[p] || null;
    const start = add && add > weekStart ? add : weekStart;
    if (add && (!drop || add > drop)) {
      windows[p] = { start, end: weekEnd }; // still rostered at the week's end
    } else if (drop && drop >= weekStart) {
      windows[p] = { start, end: drop }; // dropped mid-week; the drop day still counts
    }
    // dropped before this week began, and not re-added: not his at all this week
  }

  const arr = ((sd.rosters || {})[manager] || {})[`${round}|${week}`] || {};
  for (const p of [...(arr.batters || []), ...(arr.pitchers || [])]) {
    if (!windows[p] && !latestAdd[p] && !latestDrop[p] && !joinedAfterWeek.has(p)) {
      windows[p] = { start: weekStart, end: weekEnd };
    }
  }
  return windows;
}

// Compare every manager-week's certified subtotal against the same week rebuilt from daily rows.
// Returns one finding per disagreeing manager-week, each naming the players responsible.
function auditWeeklyRollupDrift(sd, { tolerance = 0.5 } = {}) {
  const findings = [];
  if (!sd) return findings;
  const dailyBatAll = sd.daily_batting || [];
  const dailyPitAll = sd.daily_pitching || [];
  if (dailyBatAll.length === 0 && dailyPitAll.length === 0) return findings;

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const managers = new Set(Object.keys(sd.rosters || {}));
  for (const r of batting) if (r.manager) managers.add(r.manager);
  for (const r of pitching) if (r.manager) managers.add(r.manager);
  const r2 = (n) => Math.round(n * 100) / 100;

  SEASON_SCHEDULE.forEach((schedWeek, idx) => {
    const weekDates = (sd.schedule_dates || [])[idx];
    if (!weekDates || !weekDates.start || !weekDates.end) return;
    const { round, week } = schedWeek;
    const dailyBat = dailyBatAll.filter((r) => r.round === round && r.week === week);
    const dailyPit = dailyPitAll.filter((r) => r.round === round && r.week === week);
    if (dailyBat.length === 0 && dailyPit.length === 0) return; // not played yet, or a gsheets-era week

    // Hand-set rows are exempt on both sides of the comparison.
    const overridden = new Set();
    const collectOverrides = (rows, key) => {
      for (const r of rows) {
        if (r.round !== round || r.week !== week) continue;
        if (r.drop_locked || (r.manual_fields && r.manual_fields.length > 0)) overridden.add(r[key]);
      }
    };
    collectOverrides(batting, 'batter');
    collectOverrides(pitching, 'pitcher');
    for (const r of [...dailyBat, ...dailyPit]) {
      if (r.drop_locked || (r.manual_fields && r.manual_fields.length > 0)) overridden.add(r.batter || r.pitcher);
    }

    for (const mgr of managers) {
      const batDetail = [];
      const pitDetail = [];
      const certBat = managerWeekSubtotal(sd, mgr, schedWeek, idx, batting, 'batter', 'batters', batDetail);
      const certPit = managerWeekSubtotal(sd, mgr, schedWeek, idx, pitching, 'pitcher', 'pitchers', pitDetail);
      const windows = managerWeekRosterWindows(sd, mgr, round, week, idx);
      if (!certBat && !certPit && Object.keys(windows).length === 0) continue;

      const fromDaily = {};
      for (const [player, w] of Object.entries(windows)) {
        if (overridden.has(player)) continue;
        const inWindow = (r) => (!w.start || r.date >= w.start) && (!w.end || r.date <= w.end);
        let pts = 0;
        for (const r of dailyBat) if (r.batter === player && inWindow(r)) pts += calculateBattingScore(r.delta || {});
        for (const r of dailyPit) if (r.pitcher === player && inWindow(r)) pts += calculatePitchingScore(r.delta || {});
        fromDaily[player] = r2(pts);
      }

      const certified = {};
      for (const d of [...batDetail, ...pitDetail]) {
        if (overridden.has(d.player)) continue;
        certified[d.player] = r2((certified[d.player] || 0) + (d.score || 0));
      }

      const sum = (o) => r2(Object.values(o).reduce((s, v) => s + v, 0));
      const certTotal = sum(certified);
      const dailyTotal = sum(fromDaily);
      if (Math.abs(certTotal - dailyTotal) <= tolerance) continue;

      const players = [];
      for (const p of new Set([...Object.keys(certified), ...Object.keys(fromDaily)])) {
        const c = certified[p] || 0;
        const d = fromDaily[p] || 0;
        if (Math.abs(c - d) > tolerance) players.push({ player: p, certified: c, from_daily: d, delta: r2(c - d) });
      }
      players.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      findings.push({
        manager: mgr,
        week: `${round}|${week}`,
        certified: certTotal,
        from_daily: dailyTotal,
        delta: r2(certTotal - dailyTotal),
        players,
      });
    }
  });

  return findings;
}

function buildRollupDriftSlackText(findings, year) {
  const lines = findings.slice(0, 8).map((f) => {
    const who = f.players
      .slice(0, 4)
      .map((p) => `${p.player} ${p.delta > 0 ? '+' : ''}${p.delta}`)
      .join(', ');
    const sign = f.delta > 0 ? 'over' : 'under';
    return (
      `• *${f.manager}* ${f.week}: certified ${f.certified} vs ${f.from_daily} from the daily rows ` +
      `(${sign} by ${Math.abs(f.delta)})${who ? ` — ${who}` : ''}`
    );
  });
  const more = findings.length > lines.length ? `\n_…and ${findings.length - lines.length} more._` : '';
  return (
    `:mag: *Scoring drift detected (${year})* — the certified totals disagree with the stats they are ` +
    `derived from. The posted scoreboard is using the certified numbers, so they are wrong until this ` +
    `is resolved.\n${lines.join('\n')}${more}\n` +
    `_Rebuild Totals recompiles the rollups from the stored daily rows — Sync Now only touches the ` +
    `current week, so it cannot fix a finished one. If it persists, check the named player's ` +
    `add/drop dates against that week's start and end._`
  );
}

// One alert per distinct finding-set per process — the 4am compile and the 7am post both run this,
// and an unresolved drift would otherwise re-post every morning.
let lastRollupDriftSignature = null;

async function alertOnRollupDrift(sd, year, trigger) {
  try {
    const findings = auditWeeklyRollupDrift(sd);
    if (findings.length === 0) return [];
    const signature = findings.map((f) => `${f.manager}|${f.week}|${f.delta}`).join(';');
    console.error(`[Rollup audit] (${trigger}) ${findings.length} manager-week(s) drifted: ${signature}`);
    if (signature !== lastRollupDriftSignature) {
      lastRollupDriftSignature = signature;
      await postSlack(buildRollupDriftSlackText(findings, year)).catch(() => {});
    }
    return findings;
  } catch (e) {
    console.error('[Rollup audit] error (continuing):', e.message);
    return [];
  }
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

// A daily row's `delta` is today's cumulative line minus the previous snapshot's, so it is
// only a GAME when it moved and moved FORWARD. Two things can be in there that are not games:
//
//   - An all-zero delta: the player was rostered but did not play that day.
//   - A delta with a NEGATIVE component: MLB revised an earlier box score downward (a hit
//     rescored as an error, a run reassigned), so the cumulative total dropped and the
//     difference landed on whatever date the correction happened to sync. Every batting weight
//     in SCORING is positive (1B/2B/3B/HR/R/RBI/SB/BB), which makes a negative batting game
//     arithmetically impossible — a batter showing up at -12.7 pts for a date was never a game
//     they played, it was a correction to an earlier one filed under that date. Pitchers CAN
//     legitimately go negative (H/ER/BB carry negative weights), so the guard is the negative
//     STAT, not the negative score.
//
// Neither belongs in a best/worst superlative. Weekly and season totals are computed from the
// weekly rows, not from these filters, so excluding them here moves nobody's score — it only
// stops the daily post and the roasts from narrating a stat correction as a performance.
const hadGameDelta = (delta) => !!delta && Object.values(delta).some((v) => (parseFloat(v) || 0) !== 0);
const isCorrectionDelta = (delta) => !!delta && Object.values(delta).some((v) => (parseFloat(v) || 0) < 0);
const countsAsGameDelta = (delta) => hadGameDelta(delta) && !isCorrectionDelta(delta);

// Compute high/low scores for a specific date (YYYY-MM-DD).
// Returns { bestManager, worstManager, bestPlayer, worstPlayer } or null if no data.
function computeDailyHighLow(sd, date) {
  const hadGame = countsAsGameDelta;
  const dailyBat = (sd.daily_batting || []).filter((r) => r.date === date && hadGame(r.delta));
  const dailyPit = (sd.daily_pitching || []).filter((r) => r.date === date && hadGame(r.delta));
  if (dailyBat.length === 0 && dailyPit.length === 0) return null;

  // Aggregate player scores (plus hits/strikeouts, for the worst-batter filter below)
  // across games on the same day (e.g. doubleheaders).
  const batterScores = {};
  const batterHits = {};
  const batterSO = {};
  const batterLOB = {};
  const batRoundWeek = {};
  for (const r of dailyBat) {
    const d = r.delta || {};
    batterScores[r.batter] = (batterScores[r.batter] || 0) + calculateBattingScore(d);
    batterHits[r.batter] = (batterHits[r.batter] || 0) + (d['1b'] || 0) + (d['2b'] || 0) + (d['3b'] || 0) + (d.hr || 0);
    batterSO[r.batter] = (batterSO[r.batter] || 0) + (d.so || 0);
    batterLOB[r.batter] = (batterLOB[r.batter] || 0) + (d.lob || 0);
    if (!batRoundWeek[r.batter]) batRoundWeek[r.batter] = { round: r.round, week: r.week };
  }
  const pitcherScores = {};
  const pitcherBB = {};
  const pitRoundWeek = {};
  for (const r of dailyPit) {
    const d = r.delta || {};
    pitcherScores[r.pitcher] = (pitcherScores[r.pitcher] || 0) + calculatePitchingScore(d);
    pitcherBB[r.pitcher] = (pitcherBB[r.pitcher] || 0) + (d.bb || 0);
    if (!pitRoundWeek[r.pitcher]) pitRoundWeek[r.pitcher] = { round: r.round, week: r.week };
  }

  // Manager daily totals — respect player_dates date windows.
  // Track attributed players (and their owning manager) so the player high/low only
  // covers rostered players, and the Slack post can show who owns each one.
  const managerTotals = {};
  const attributedBatters = new Set();
  const attributedPitchers = new Set();
  const batterManager = {};
  const pitcherManager = {};
  const addToManager = (playerName, pdType, score, round, week) => {
    const playerType = pdType === 'batter' ? 'batting' : 'pitching';
    // Resolve the owner AS OF this date, not as of now: a player swapped out yesterday still owns
    // yesterday's points for the manager who rostered him then.
    const mgr = findManagerForPlayerDate(sd, playerName, playerType, round, week, date);
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
    if (pdType === 'batter') {
      attributedBatters.add(playerName);
      batterManager[playerName] = mgr;
    } else {
      attributedPitchers.add(playerName);
      pitcherManager[playerName] = mgr;
    }
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
      .map(([name, score]) => ({
        name,
        score: Math.round(score * 100) / 100,
        type: 'Batter',
        manager: batterManager[name],
        hits: batterHits[name] || 0,
        so: batterSO[name] || 0,
        lob: batterLOB[name] || 0,
      })),
    ...Object.entries(pitcherScores)
      .filter(([name]) => attributedPitchers.has(name))
      .map(([name, score]) => ({
        name,
        score: Math.round(score * 100) / 100,
        type: 'Pitcher',
        manager: pitcherManager[name],
        bb: pitcherBB[name] || 0,
      })),
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

  // Top/bottom managers must be disjoint — with fewer than 6 managers playing that day
  // (e.g. SF/Finals rounds), slicing both ends independently would show the same
  // manager in both the best and worst lists.
  const topManagerCount = Math.min(3, managers.length);
  const topManagersList = managers.slice(0, topManagerCount);
  const remainingManagers = managers.slice(topManagerCount);
  const bottomManagerCount = Math.min(3, remainingManagers.length);
  const bottomManagersList = remainingManagers.slice(-bottomManagerCount).reverse();

  // Worst Player Days: batters can never score negative points (every batting weight is
  // positive), so a 0.0 line doesn't mean a bad day on its own — only flag a batter if they
  // also went hitless with 3+ strikeouts. Pitchers can go negative, so any negative day qualifies.
  const worstPlayers = allPlayers
    .filter((p) => (p.type === 'Pitcher' ? p.score < 0 : p.score === 0 && p.hits === 0 && p.so >= 3))
    .sort((a, b) => {
      // Lowest score is worst (negative-scoring pitchers sort first). Among the hitless
      // batters — all tied at 0 — order by strikeout severity so the badges read worst-first:
      // platinum sombrero (5+ K) > golden sombrero (4 K) > hat trick (3 K).
      if (a.score !== b.score) return a.score - b.score;
      return (b.so || 0) - (a.so || 0);
    })
    .slice(0, 3);

  // Fallback for the roast when nobody qualifies for worstPlayers above: the single
  // lowest-scoring player of the day, tiebroken by strikeouts (pitchers go negative and
  // will naturally sort last; among tied batters, more strikeouts is the worse day).
  const worstPlayerOverall = [...allPlayers].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return (b.so || 0) - (a.so || 0);
  })[0];

  return {
    topManagers: topManagersList,
    bottomManagers: bottomManagersList,
    topPlayers: allPlayers.slice(0, 3),
    bottomPlayers: worstPlayers,
    worstPlayerOverall,
    // Every manager's date-windowed total for this day, unsliced. The top/bottom lists above
    // are cut to 3, so a head-to-head narrative (computeMatchupNarrativeForRoast) can't be
    // built from them — it needs both sides of a matchup on every day, however they placed.
    managerTotals,
  };
}

// ============================================================
// Playoff odds (Monte-Carlo) — PP2 Week 4–5 only
// ============================================================
// Simulates every manager's remaining PP2 production (per-player per-game
// scoring rates x their team's remaining MLB games) and applies the exact
// qualification rules — win your pool's PP1 or PP2 period, or take a
// wildcard on combined total — to each simulated season. Results are stored
// on the season as `sd.playoff_odds` (a derived cache, like the weekly
// rollups: rebuilt daily, never authoritative for anything) so the
// scoreboard UI and the Slack post always read identical numbers.
//
// The pure engine below (ODDS_WINDOW through formatOddsPct) is a synced copy
// of js/playoffOdds.js — the canonical, unit-tested version lives there.
// Keep both in sync, like SCORING/SEASON_SCHEDULE and detectScoreSwings.

const ODDS_WINDOW = { round: 'PP2', firstWeek: 'Week 4', lastWeek: 'Week 5' };
const ODDS_DEFAULT_SIMS = 10000;

function oddsWindowForDate(scheduleDates, todayISO, schedule = SEASON_SCHEDULE) {
  if (!Array.isArray(scheduleDates) || !todayISO) return null;
  const idxOf = (round, week) => schedule.findIndex((s) => s.round === round && s.week === week);
  const firstIdx = idxOf(ODDS_WINDOW.round, ODDS_WINDOW.firstWeek);
  const lastIdx = idxOf(ODDS_WINDOW.round, ODDS_WINDOW.lastWeek);
  if (firstIdx === -1 || lastIdx === -1) return null;
  const first = scheduleDates[firstIdx] || {};
  const last = scheduleDates[lastIdx] || {};
  if (!first.start || !last.end) return null;
  if (todayISO < first.start || todayISO > last.end) return null;
  return {
    round: ODDS_WINDOW.round,
    week: first.end && todayISO <= first.end ? ODDS_WINDOW.firstWeek : ODDS_WINDOW.lastWeek,
    start: first.start,
    end: last.end,
  };
}

function meanVariance(xs) {
  const arr = Array.isArray(xs) ? xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)) : [];
  const n = arr.length;
  if (n === 0) return { mean: 0, variance: 0, n: 0 };
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { mean, variance: 0, n };
  const variance = arr.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  return { mean, variance, n };
}

function playerGameRate(gameScores, baseline = { mean: 0, variance: 0 }, k = 5) {
  const { mean: sMean, variance: sVar, n } = meanVariance(gameScores);
  const bMean = baseline.mean || 0;
  const bVar = baseline.variance || 0;
  const mean = (sMean * n + bMean * k) / (n + k || 1);
  const ownVar = n >= 2 ? sVar : bVar;
  const variance = (ownVar * n + bVar * k) / (n + k || 1);
  return { mean, variance, games: n };
}

// ---- Schedule-context adjustments (opponent quality, home/away, park factor) ----
// Layered on top of the base per-game rate from playerGameRate. Every factor is
// centered at 1.0 (neutral) and the combined per-game multiplier is clamped so no
// combination of extremes can dominate the simulation.

// Generic MLB-wide home-field scoring edge (not team-specific) — modest and
// well-established historically. Applied the same direction to both batting and
// pitching, unlike park factor, which cuts the other way for pitchers.
const HOME_ADVANTAGE = 0.03; // home = x1.03, away = x0.97

// Team-abbreviation -> home-park run-scoring multiplier. Approximate MULTI-YEAR
// averages (not live/current-season). Review and refresh at the start of each
// season. ATH/OAK (Athletics, mid-relocation) and TB (Rays, temporary home after
// Tropicana Field storm damage) are left neutral (1.0) rather than guessed —
// confirm their current-season home park before trusting those two.
const PARK_FACTORS = {
  ARI: 1.02,
  ATL: 1.01,
  ATH: 1.0,
  OAK: 1.0,
  BAL: 0.98,
  BOS: 1.04,
  CHC: 1.02,
  CWS: 1.0,
  CIN: 1.05,
  CLE: 0.97,
  COL: 1.15,
  DET: 0.97,
  HOU: 1.0,
  KC: 0.99,
  LAA: 0.98,
  LAD: 0.97,
  MIA: 0.95,
  MIL: 1.0,
  MIN: 0.99,
  NYM: 0.97,
  NYY: 1.02,
  PHI: 1.03,
  PIT: 0.97,
  SD: 0.93,
  SEA: 0.94,
  SF: 0.9,
  STL: 0.99,
  TB: 1.0,
  TEX: 1.02,
  TOR: 1.0,
  WSH: 0.98,
};

const PARK_FACTOR_CLAMP = [0.85, 1.15];
const OPPONENT_FACTOR_CLAMP = [0.85, 1.15];
const GAME_FACTOR_CLAMP = [0.7, 1.5];
const oddsClamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

function computeTeamQualityFactors(teamStats) {
  const eras = Object.values(teamStats || {})
    .map((t) => t.era)
    .filter((x) => typeof x === 'number' && x > 0);
  const rpgs = Object.values(teamStats || {})
    .map((t) => t.runsPerGame)
    .filter((x) => typeof x === 'number' && x > 0);
  const leagueEra = eras.length ? eras.reduce((a, b) => a + b, 0) / eras.length : null;
  const leagueRpg = rpgs.length ? rpgs.reduce((a, b) => a + b, 0) / rpgs.length : null;

  const out = {};
  for (const [abbrev, t] of Object.entries(teamStats || {})) {
    const pitchingRelative =
      leagueEra && typeof t.era === 'number' && t.era > 0 ? oddsClamp(t.era / leagueEra, OPPONENT_FACTOR_CLAMP) : 1;
    const hittingRelative =
      leagueRpg && typeof t.runsPerGame === 'number' && t.runsPerGame > 0
        ? oddsClamp(t.runsPerGame / leagueRpg, OPPONENT_FACTOR_CLAMP)
        : 1;
    out[abbrev] = { pitchingRelative, hittingRelative };
  }
  return out;
}

function gameFactor(playerType, game, teamQuality = {}, parkFactors = PARK_FACTORS) {
  const opp = game && teamQuality[game.opponent];
  const opponentFactor = opp ? (playerType === 'batter' ? opp.pitchingRelative : 1 / opp.hittingRelative) : 1;
  const homeAwayFactor = game && game.isHome ? 1 + HOME_ADVANTAGE : 1 - HOME_ADVANTAGE;
  const rawPark = oddsClamp((game && parkFactors[game.venueTeam]) ?? 1, PARK_FACTOR_CLAMP);
  const parkFactorApplied = playerType === 'batter' ? rawPark : 1 / rawPark;
  return oddsClamp(opponentFactor * homeAwayFactor * parkFactorApplied, GAME_FACTOR_CLAMP);
}

function projectManager(playerProjections) {
  let mean = 0;
  let variance = 0;
  let games = 0;
  for (const p of playerProjections || []) {
    const factors = Array.isArray(p.gameFactors) ? p.gameFactors : [];
    const sumFactors = factors.reduce((s, f) => s + f, 0);
    const sumFactorsSq = factors.reduce((s, f) => s + f * f, 0);
    mean += (p.mean || 0) * sumFactors;
    variance += (p.variance || 0) * sumFactorsSq;
    games += factors.length;
  }
  return { mean, variance, games };
}

function currentQualification(entries, bracketSize = 8) {
  const pools = {};
  for (const e of entries) (pools[e.pool] = pools[e.pool] || []).push(e);

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();
  const pp1LeaderByPool = {};
  const pp2LeaderByPool = {};
  for (const [pool, members] of Object.entries(pools)) {
    let b1 = 0;
    let w1 = null;
    let b2 = 0;
    let w2 = null;
    for (const m of members) {
      if ((m.pp1 || 0) > b1) {
        b1 = m.pp1;
        w1 = m.manager;
      }
      if ((m.pp2 || 0) > b2) {
        b2 = m.pp2;
        w2 = m.manager;
      }
    }
    if (w1) {
      pp1Leaders.add(w1);
      pp1LeaderByPool[pool] = { manager: w1, pp1: b1 };
    }
    if (w2) {
      pp2Leaders.add(w2);
      pp2LeaderByPool[pool] = { manager: w2, pp2: b2 };
    }
  }

  const total = (e) => (e.pp1 || 0) + (e.pp2 || 0);
  const allLeaders = new Set([...pp1Leaders, ...pp2Leaders]);
  const winners = entries.filter((e) => allLeaders.has(e.manager)).sort((a, b) => total(b) - total(a));
  const wildcards = entries
    .filter((e) => !allLeaders.has(e.manager) && total(e) > 0)
    .sort((a, b) => total(b) - total(a))
    .slice(0, Math.max(0, bracketSize - winners.length));
  const qualifiers = [...winners, ...wildcards].slice(0, bracketSize);
  const cutTotal = qualifiers.length > 0 ? total(qualifiers[qualifiers.length - 1]) : 0;

  return {
    pp1Leaders,
    pp2Leaders,
    pp1LeaderByPool,
    pp2LeaderByPool,
    qualifierNames: qualifiers.map((e) => e.manager),
    cutTotal,
  };
}

function makeNormalSampler(rng = Math.random) {
  return function normal() {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function simulatePlayoffOdds({
  entries,
  projections = {},
  bracketSize = 8,
  sims = ODDS_DEFAULT_SIMS,
  rng = Math.random,
}) {
  const normal = makeNormalSampler(rng);
  const names = entries.map((e) => e.manager);
  const pools = {};
  entries.forEach((e, i) => {
    (pools[e.pool] = pools[e.pool] || []).push(i);
  });

  // PP1 is complete in the odds window — its per-pool winners are fixed.
  const pp1WinnerIdx = new Set();
  for (const idxs of Object.values(pools)) {
    let best = 0;
    let winner = -1;
    for (const i of idxs) {
      if ((entries[i].pp1 || 0) > best) {
        best = entries[i].pp1;
        winner = i;
      }
    }
    if (winner >= 0) pp1WinnerIdx.add(winner);
  }

  const means = names.map((n) => (projections[n] && projections[n].mean) || 0);
  const sds = names.map((n) => Math.sqrt(Math.max(0, (projections[n] && projections[n].variance) || 0)));

  const counts = names.map(() => ({ make: 0, winPP2Pool: 0, wildcard: 0 }));
  const pp2Sim = new Array(names.length);
  const totalSim = new Array(names.length);

  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < names.length; i++) {
      const drawn = sds[i] > 0 ? means[i] + sds[i] * normal() : means[i];
      pp2Sim[i] = (entries[i].pp2 || 0) + drawn;
      totalSim[i] = (entries[i].pp1 || 0) + pp2Sim[i];
    }

    // Per-pool PP2 winner on simulated totals.
    const winnerIdx = new Set(pp1WinnerIdx);
    for (const idxs of Object.values(pools)) {
      let best = 0;
      let winner = -1;
      for (const i of idxs) {
        if (pp2Sim[i] > best) {
          best = pp2Sim[i];
          winner = i;
        }
      }
      if (winner >= 0) {
        winnerIdx.add(winner);
        counts[winner].winPP2Pool++;
      }
    }

    // Wildcards: highest combined totals among non-winners, filling to bracketSize.
    const wcSlots = Math.max(0, bracketSize - winnerIdx.size);
    const nonWinners = [];
    for (let i = 0; i < names.length; i++) {
      if (!winnerIdx.has(i) && totalSim[i] > 0) nonWinners.push(i);
    }
    nonWinners.sort((a, b) => totalSim[b] - totalSim[a]);
    const wildcardIdx = nonWinners.slice(0, wcSlots);

    // Winners seed first — when they exceed the bracket, lowest totals miss.
    let qualifiedIdx;
    if (winnerIdx.size > bracketSize) {
      qualifiedIdx = [...winnerIdx].sort((a, b) => totalSim[b] - totalSim[a]).slice(0, bracketSize);
    } else {
      qualifiedIdx = [...winnerIdx, ...wildcardIdx];
    }
    for (const i of qualifiedIdx) counts[i].make++;
    for (const i of wildcardIdx) counts[i].wildcard++;
  }

  const managers = {};
  names.forEach((n, i) => {
    managers[n] = {
      make: counts[i].make / sims,
      winPP2Pool: counts[i].winPP2Pool / sims,
      wildcard: counts[i].wildcard / sims,
      lockedPP1: pp1WinnerIdx.has(i),
    };
  });
  return { sims, managers };
}

function formatOddsPct(fraction, locked = false) {
  if (locked) return '100%';
  const pct = fraction * 100;
  if (pct >= 99.5) return '>99%';
  if (pct > 0 && pct < 0.5) return '<1%';
  return `${Math.round(pct)}%`;
}

// ---- Server-only glue (not part of the synced pure engine) ----

// Per-player per-game season scores from the daily rows. Batting and
// pitching deltas for the same game (two-way players) merge into one score.
// Rows without a game_id (manual/gsheets imports) fall back to keying by
// date so they still count as one appearance.
function collectPlayerGameScores(sd) {
  const perGame = new Map(); // name -> Map(gameKey -> score)
  const add = (name, key, score) => {
    if (!perGame.has(name)) perGame.set(name, new Map());
    const games = perGame.get(name);
    games.set(key, (games.get(key) || 0) + score);
  };
  for (const r of sd.daily_batting || []) {
    const stats = r.delta || r.cumulative;
    if (!r.batter || !stats) continue;
    add(r.batter, r.game_id != null ? `g${r.game_id}` : `d${r.date}`, calculateBattingScore(stats));
  }
  for (const r of sd.daily_pitching || []) {
    const stats = r.delta || r.cumulative;
    if (!r.pitcher || !stats) continue;
    add(r.pitcher, r.game_id != null ? `g${r.game_id}` : `d${r.date}`, calculatePitchingScore(stats));
  }
  const out = new Map();
  for (const [name, games] of perGame) out.set(name, [...games.values()]);
  return out;
}

// A manager's active PP2 roster as of `todayISO`, derived from the
// authoritative date windows (roster_dates scoped to the PP2 period start,
// latest add <= today with no later drop) — the same latest-add/latest-drop
// logic managerWeekSubtotal uses, evaluated as of today instead of week end.
function activeRosterForOdds(sd, managerName, todayISO) {
  const allMgrDates = (sd.roster_dates && sd.roster_dates[managerName]) || null;
  if (!allMgrDates) return [];
  const periodStart = periodStartForRound(sd, ODDS_WINDOW.round);
  const latestAdd = {};
  const latestDrop = {};
  for (const players of Object.values(allMgrDates)) {
    for (const [p, d] of Object.entries(players || {})) {
      if (
        d.add_date &&
        (!periodStart || d.add_date >= periodStart) &&
        d.add_date <= todayISO &&
        (!latestAdd[p] || d.add_date > latestAdd[p])
      ) {
        latestAdd[p] = d.add_date;
      }
      if (
        d.drop_date &&
        (!periodStart || d.drop_date >= periodStart) &&
        d.drop_date <= todayISO &&
        (!latestDrop[p] || d.drop_date > latestDrop[p])
      ) {
        latestDrop[p] = d.drop_date;
      }
    }
  }
  return Object.keys(latestAdd).filter((p) => !latestDrop[p] || latestAdd[p] > latestDrop[p]);
}

// MLB team id -> abbreviation, shared by fetchRemainingGamesByTeam and
// fetchTeamSeasonQuality so a compute only fetches the roster once.
async function fetchTeamIdAbbrevMap() {
  const teamsData = await mlbApiFetch('/api/v1/teams?sportId=1');
  const map = {};
  for (const t of teamsData.teams || []) map[t.id] = t.abbreviation;
  return map;
}

// Remaining (not-yet-Final) MLB games per team abbreviation in a date range,
// each carrying its opponent, home/away, and venue team (whichever side is
// home — that's whose park the game is played at) — feeds both the
// "games remaining" display metric and the schedule-strength adjustment.
async function fetchRemainingGamesByTeam(startDate, endDate, idToAbbrev) {
  const data = await mlbApiFetch(
    `/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&gameType=R,F,D,L,W`
  );
  const byTeam = {};
  const add = (abbrev, game) => {
    (byTeam[abbrev] = byTeam[abbrev] || []).push(game);
  };
  for (const dateEntry of data.dates || []) {
    for (const game of dateEntry.games || []) {
      if (game.status?.abstractGameState === 'Final') continue;
      const homeAbbrev = idToAbbrev[game.teams?.home?.team?.id];
      const awayAbbrev = idToAbbrev[game.teams?.away?.team?.id];
      if (!homeAbbrev || !awayAbbrev) continue;
      add(homeAbbrev, { opponent: awayAbbrev, isHome: true, venueTeam: homeAbbrev });
      add(awayAbbrev, { opponent: homeAbbrev, isHome: false, venueTeam: homeAbbrev });
    }
  }
  return byTeam; // { [abbrev]: [{opponent, isHome, venueTeam}, ...] }
}

// Team-level season quality signal (ERA + runs/game) for every team, in two
// bulk calls rather than one per team. Best-effort: a failed call or a team
// missing/unparseable stats simply leaves that team out of the map, which
// computeTeamQualityFactors treats as neutral (1.0) — never blocks the compute.
async function fetchTeamSeasonQuality(season, idToAbbrev) {
  const out = {};
  try {
    const pitching = await mlbApiFetch(`/api/v1/teams/stats?sportId=1&season=${season}&stats=season&group=pitching`);
    for (const split of pitching.stats?.[0]?.splits || []) {
      const abbrev = idToAbbrev[split.team?.id];
      const era = Number(split.stat?.era);
      if (!abbrev || !(era > 0)) continue;
      (out[abbrev] = out[abbrev] || {}).era = era;
    }
  } catch (e) {
    console.error('[PlayoffOdds] Team pitching stats fetch failed (opponent factors neutral):', e.message);
  }
  try {
    const hitting = await mlbApiFetch(`/api/v1/teams/stats?sportId=1&season=${season}&stats=season&group=hitting`);
    for (const split of hitting.stats?.[0]?.splits || []) {
      const abbrev = idToAbbrev[split.team?.id];
      const runs = Number(split.stat?.runs);
      const gp = Number(split.stat?.gamesPlayed);
      if (!abbrev || !(runs > 0) || !(gp > 0)) continue;
      (out[abbrev] = out[abbrev] || {}).runsPerGame = runs / gp;
    }
  } catch (e) {
    console.error('[PlayoffOdds] Team hitting stats fetch failed (opponent factors neutral):', e.message);
  }
  return out; // { [abbrev]: { era?, runsPerGame? } }
}

// Compute the full odds payload for one season, or null when outside the
// PP2 Week 4–5 window (or pool play is already finalized / pools missing).
// Managers come from db.managers (the canonical list), scores from
// computeRoundScores (the same drop-aware path as the scoreboard).
async function computePlayoffOddsForSeason(db, sd, todayISO, year) {
  const window = oddsWindowForDate(sd.schedule_dates || [], todayISO);
  if (!window) return null;
  if ((sd.finalized_rounds || []).includes('PP')) return null;

  const managers = (db.managers || []).filter((m) => m.active !== false && m.pool);
  if (managers.length === 0) return null;

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const pp1Totals = {};
  for (const s of computeRoundScores(batting, pitching, ['PP1'], sd)) pp1Totals[s.manager] = s.total;
  const pp2Totals = {};
  for (const s of computeRoundScores(batting, pitching, ['PP2'], sd)) pp2Totals[s.manager] = s.total;
  const entries = managers.map((m) => ({
    manager: m.name,
    pool: m.pool,
    pp1: pp1Totals[m.name] || 0,
    pp2: pp2Totals[m.name] || 0,
  }));

  const gameScores = collectPlayerGameScores(sd);
  const allScores = [];
  for (const scores of gameScores.values()) allScores.push(...scores);
  const baseline = meanVariance(allScores);

  // Schedule-context signals (opponent quality, home/away, park factor). Each
  // fetch fails safe to neutral — a bad response never blocks the nightly
  // compute, it just leaves that one signal at 1.0 for the affected teams.
  let idToAbbrev = {};
  try {
    idToAbbrev = await fetchTeamIdAbbrevMap();
  } catch (e) {
    console.error('[PlayoffOdds] Team id/abbrev map fetch failed (adjustments neutral):', e.message);
  }
  const remainingByTeam = await fetchRemainingGamesByTeam(todayISO, window.end, idToAbbrev);
  const teamStats = await fetchTeamSeasonQuality(year, idToAbbrev);
  const teamQuality = computeTeamQualityFactors(teamStats);
  const batPoolSet = new Set(sd.batters_pool || []);

  const teamCounts = Object.values(remainingByTeam).map((g) => g.length);
  const avgRemaining = teamCounts.length > 0 ? teamCounts.reduce((a, b) => a + b, 0) / teamCounts.length : 0;

  const projections = {};
  const avgFactorByManager = {};
  for (const m of managers) {
    const roster = activeRosterForOdds(sd, m.name, todayISO);
    const perPlayer = roster.map((player) => {
      const rate = playerGameRate(gameScores.get(player) || [], baseline);
      const team = (sd.batters_team || {})[player] || (sd.pitchers_team || {})[player] || null;
      const playerType = batPoolSet.has(player) ? 'batter' : 'pitcher';
      const games = team && remainingByTeam[team];
      const gameFactors = games
        ? games.map((g) => gameFactor(playerType, g, teamQuality))
        : Array.from({ length: Math.round(avgRemaining) }, () => 1);
      return { mean: rate.mean, variance: rate.variance, gameFactors };
    });
    projections[m.name] = projectManager(perPlayer);
    const allFactors = perPlayer.flatMap((p) => p.gameFactors);
    avgFactorByManager[m.name] = allFactors.length ? allFactors.reduce((a, b) => a + b, 0) / allFactors.length : 1;
  }

  const sim = simulatePlayoffOdds({ entries, projections });
  const qual = currentQualification(entries);

  const pct1 = (fraction) => Math.round(fraction * 1000) / 10;
  const r1 = (x) => Math.round(x * 10) / 10;
  const managersOut = {};
  for (const e of entries) {
    const s = sim.managers[e.manager];
    const poolLead = qual.pp2LeaderByPool[e.pool];
    managersOut[e.manager] = {
      pct: s.lockedPP1 ? 100 : pct1(s.make),
      pool_win_pct: pct1(s.winPP2Pool),
      wildcard_pct: pct1(s.wildcard),
      locked: s.lockedPP1,
      proj_mean: r1(projections[e.manager].mean),
      games_remaining: Math.round(projections[e.manager].games),
      points_back_pool: poolLead ? r1(poolLead.pp2 - e.pp2) : null,
      points_back_cut: r1(qual.cutTotal - (e.pp1 + e.pp2)),
      schedule_factor: Math.round((avgFactorByManager[e.manager] || 1) * 1000) / 1000,
    };
  }

  return {
    computed_at: new Date().toISOString(),
    date: todayISO,
    sims: sim.sims,
    round: window.round,
    week: window.week,
    window: { start: window.start, end: window.end },
    managers: managersOut,
  };
}

// Roll the previous odds' daily history forward onto a fresh payload so the
// scoreboard and Slack post can show day-over-day movement. One entry per
// date (a same-day recompute replaces), capped to the odds window's length.
const MAX_ODDS_HISTORY = 21;
function attachPlayoffOddsHistory(sd, odds) {
  const prev = sd.playoff_odds && Array.isArray(sd.playoff_odds.history) ? sd.playoff_odds.history : [];
  const history = prev.filter((h) => h.date !== odds.date);
  const pcts = {};
  for (const [name, o] of Object.entries(odds.managers)) pcts[name] = o.pct;
  history.push({ date: odds.date, pcts });
  history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  odds.history = history.slice(-MAX_ODDS_HISTORY);
}

// Compute-and-store on a FRESH db copy (own read-modify-write, so it can run
// after the 4am sync's write or standalone from the 7am post / the manual
// endpoint without clobbering anything). No-ops outside the odds window or
// when today's odds already exist (unless forced). Returns the stored odds
// or null.
async function ensureFreshPlayoffOdds(year, opts = {}) {
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return null;
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (!opts.force && sd.playoff_odds && sd.playoff_odds.date === todayISO) return sd.playoff_odds;
  const odds = await computePlayoffOddsForSeason(db, sd, todayISO, year);
  if (!odds) return null;
  attachPlayoffOddsHistory(sd, odds);
  sd.playoff_odds = odds;
  writeDB(db);
  console.log(
    `[PlayoffOdds] Computed ${year} playoff odds for ${todayISO} (${odds.sims} sims, trigger: ${opts.trigger || 'manual'})`
  );
  return odds;
}

// Slack mrkdwn section for the daily scoreboard post — only during the odds
// window, reading the stored payload so the post matches the scoreboard UI.
function buildPlayoffOddsSlackText(sd, todayISO) {
  const odds = sd.playoff_odds;
  if (!odds || !odds.managers) return null;
  if ((sd.finalized_rounds || []).includes('PP')) return null;
  if (!oddsWindowForDate(sd.schedule_dates || [], todayISO)) return null;

  const history = Array.isArray(odds.history) ? odds.history : [];
  const prior = [...history].reverse().find((h) => h.date < odds.date);

  const rows = Object.entries(odds.managers)
    .map(([name, o]) => ({ name, ...o }))
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));

  const lines = rows.map((r) => {
    const label = formatOddsPct(r.pct / 100, r.locked);
    let suffix = '';
    if (r.locked) {
      suffix = ' \u{1F512}';
    } else {
      if (prior && prior.pcts && prior.pcts[r.name] != null) {
        const delta = Math.round(r.pct - prior.pcts[r.name]);
        if (delta >= 1) suffix = ` \u{25B2}+${delta}`;
        else if (delta <= -1) suffix = ` \u{25BC}${delta}`;
      }
      suffix += ` _(pool ${formatOddsPct(r.pool_win_pct / 100)} \u{00B7} WC ${formatOddsPct(r.wildcard_pct / 100)})_`;
    }
    return `*${r.name}* — ${label}${suffix}`;
  });

  return (
    `*\u{1F52E} Playoff Odds* — ${odds.sims.toLocaleString('en-US')} simulated finishes\n` +
    lines.join('\n') +
    `\n_\u{1F512} = clinched (PP1 pool winner) \u{00B7} pool/WC = odds of winning the PP2 pool vs. a wild card_`
  );
}

// Head-to-head matchup section for the daily post during playoff rounds (QF/SF/Finals) and
// the Monday wrap-up posts. Pairings and tie rules mirror app.js buildActivePlayoffBracket /
// roundMatchupWinner: QF pairs come from the confirmed_seeding snapshot locked at "End Pool
// Play" (1v8, 4v5, 3v6, 2v7 in bracket order); SF1 = QF1 winner vs QF4 winner, SF2 = QF3
// winner vs QF2 winner; the Finals championship is the SF winners and 3rd place the SF
// losers (3rd-place ties keep the app's t1-favoring `>=`). Matchup winners are derived from
// round totals + seed tiebreak directly — identical to the app's finalized bracket, without
// waiting on a finalize save. `final: true` (the Monday wrap-up) marks winners/losers and
// adds the advancement/champion footer. Returns null when no confirmed seeding is stored
// (pool play not ended in the app yet) — the caller degrades to a plain ranked list.
// Core bracket-pairing math shared by buildPlayoffMatchupsSlackText (display) and
// playoffMatchupResultForRoast (roast context): who played whom in QF/SF/Finals, and who
// won, derived from the confirmed_seeding snapshot + round totals — never re-derived from
// raw stats, so it can never disagree with the live bracket. Returns null when no confirmed
// seeding is stored yet (pool play not ended in the app) or `round` isn't playoff-shaped.
// `score(r, manager)` returns `{batting, pitching, total}` for round r (memoized).
function computePlayoffPairs(sd, round) {
  const seeds =
    sd.confirmed_seeding && Array.isArray(sd.confirmed_seeding.qualifierNames)
      ? sd.confirmed_seeding.qualifierNames
      : null;
  if (!seeds || seeds.length < 8) return null;

  const seedRank = {};
  seeds.forEach((n, i) => (seedRank[n] = i + 1));

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const totalsByRound = {};
  const score = (r, manager) => {
    if (!totalsByRound[r]) {
      totalsByRound[r] = {};
      for (const row of computeRoundScores(batting, pitching, [r], sd)) totalsByRound[r][row.manager] = row;
    }
    return totalsByRound[r][manager] || { batting: 0, pitching: 0, total: 0 };
  };
  // Higher round total wins; a tie goes to the better seed (mirrors roundMatchupWinner).
  const winner = (r, a, b) => {
    const ta = score(r, a).total;
    const tb = score(r, b).total;
    if (ta !== tb) return ta > tb ? a : b;
    return (seedRank[a] ?? Infinity) <= (seedRank[b] ?? Infinity) ? a : b;
  };

  const qfPairs = [
    { label: 'QF1', a: seeds[0], b: seeds[7] },
    { label: 'QF4', a: seeds[3], b: seeds[4] },
    { label: 'QF3', a: seeds[2], b: seeds[5] },
    { label: 'QF2', a: seeds[1], b: seeds[6] },
  ];

  let pairs;
  if (round === 'QF') {
    pairs = qfPairs.map((p) => ({ ...p, r: 'QF', leader: winner('QF', p.a, p.b) }));
  } else if (round === 'SF') {
    const qfW = qfPairs.map((p) => winner('QF', p.a, p.b));
    pairs = [
      { label: 'SF1', a: qfW[0], b: qfW[1] },
      { label: 'SF2', a: qfW[2], b: qfW[3] },
    ].map((p) => ({ ...p, r: 'SF', leader: winner('SF', p.a, p.b) }));
  } else if (round === 'Finals') {
    const qfW = qfPairs.map((p) => winner('QF', p.a, p.b));
    const sfPairs = [
      { a: qfW[0], b: qfW[1] },
      { a: qfW[2], b: qfW[3] },
    ];
    const sfW = sfPairs.map((p) => winner('SF', p.a, p.b));
    const sfL = sfPairs.map((p, i) => (sfW[i] === p.a ? p.b : p.a));
    const thirdLeader = score('Finals', sfL[0]).total >= score('Finals', sfL[1]).total ? sfL[0] : sfL[1];
    pairs = [
      { label: 'Championship', a: sfW[0], b: sfW[1], r: 'Finals', leader: winner('Finals', sfW[0], sfW[1]) },
      { label: '3rd Place', a: sfL[0], b: sfL[1], r: 'Finals', leader: thirdLeader },
    ];
  } else {
    return null;
  }

  return { pairs, score, seedRank };
}

// A given manager's own playoff-round matchup result (opponent, both scores, margin, won?)
// for the elimination-roast context — "how close did they come" for QF/SF/Finals, the
// playoff-round equivalent of the PP standings block. Null if the round/seeding isn't
// determined yet, or the manager wasn't a participant in this round.
function playoffMatchupResultForRoast(sd, round, manager) {
  const computed = computePlayoffPairs(sd, round);
  if (!computed) return null;
  const { pairs, score } = computed;
  const pair = pairs.find((p) => p.a === manager || p.b === manager);
  if (!pair) return null;
  const opponent = pair.a === manager ? pair.b : pair.a;
  const mine = score(pair.r, manager).total;
  const theirs = score(pair.r, opponent).total;
  return {
    label: pair.label,
    opponent,
    myScore: Math.round(mine * 100) / 100,
    opponentScore: Math.round(theirs * 100) / 100,
    margin: Math.round(Math.abs(mine - theirs) * 100) / 100,
    won: pair.leader === manager,
  };
}

function buildPlayoffMatchupsSlackText(sd, round, { final = false } = {}) {
  const computed = computePlayoffPairs(sd, round);
  if (!computed) return null;
  const { pairs, score, seedRank } = computed;

  const fmt = (n) => {
    const s = n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };

  const matchupText = (label, r, a, b, leader) => {
    const line = (name) => {
      const s = score(r, name);
      const seedTag = seedRank[name] ? `(${seedRank[name]}) ` : '';
      const core = `${seedTag}${name} — ${fmt(s.total)}`;
      const mark = final ? (name === leader ? ' \u{2705}' : ' \u{274C}') : '';
      return `\u{25B8} ${name === leader ? `*${core}*` : core} _(B: ${fmt(s.batting)} | P: ${fmt(s.pitching)})_${mark}`;
    };
    return `*${label}*\n${line(a)}\n${line(b)}`;
  };

  let heading;
  let footer = '';
  if (round === 'QF') {
    heading = final ? '\u{1F3C1} *Quarterfinal Results*' : '\u{1F94A} *Quarterfinal Matchups*';
    if (final) footer = `Advancing to the Semifinals: ${pairs.map((p) => `*${p.leader}*`).join(', ')}`;
  } else if (round === 'SF') {
    heading = final ? '\u{1F3C1} *Semifinal Results*' : '\u{1F94A} *Semifinal Matchups*';
    if (final) footer = `Advancing to the Finals: ${pairs.map((p) => `*${p.leader}*`).join(' vs ')}`;
  } else if (round === 'Finals') {
    heading = final ? '\u{1F3C1} *Finals Results*' : '\u{1F94A} *Championship & 3rd Place*';
    if (final) {
      footer = `\u{1F3C6} *${pairs[0].leader} wins the Whit Merrifield Memorial Cup!* \u{1F949} ${pairs[1].leader} takes 3rd place.`;
    }
  }

  return (
    `${heading}\n\n` +
    pairs.map((p) => matchupText(p.label, p.r, p.a, p.b, p.leader)).join('\n\n') +
    (footer ? `\n\n${footer}` : '')
  );
}

function buildScoreboardBlocks(db, year, opts = {}) {
  const seasonData = (db.seasons || {})[year] || {};
  const managers = db.managers || [];

  const managerPoolMap = {};
  managers.forEach((m) => {
    if (m.pool) managerPoolMap[m.name] = m.pool;
  });

  // Short manager names for the player-ownership tag next to Best/Worst Player Days:
  // first name only, unless two managers share a first name — then add the first
  // initial of the last name to disambiguate.
  const shortMgrNames = {};
  {
    const firstNameCounts = {};
    managers.forEach((m) => {
      const first = (m.name || '').split(' ')[0];
      if (first) firstNameCounts[first] = (firstNameCounts[first] || 0) + 1;
    });
    managers.forEach((m) => {
      const parts = (m.name || '').split(' ');
      const first = parts[0] || m.name;
      shortMgrNames[m.name] = firstNameCounts[first] > 1 && parts[1] ? `${first} ${parts[1][0]}.` : first;
    });
  }

  // Determine current round. null means this process cannot say which period the post covers
  // — see resolveScoreboardRound. The label below degrades to 'Season' in that case, but
  // postScoreboardSlack refuses to send such a post, so it never reaches the channel.
  const scheduleDates = seasonData.schedule_dates || [];
  let currentRound = resolveScoreboardRound(seasonData);

  // Monday wrap-up posts report the round that just ENDED, even when the next round's
  // window already contains today (e.g. SF Week 1 starts the Monday after QF ends).
  const summaryRound = ['PP2', 'QF', 'SF', 'Finals'].includes(opts.summaryRound) ? opts.summaryRound : null;
  if (summaryRound) currentRound = summaryRound;

  const currentRoundLabel = ROUND_LABELS[currentRound] || currentRound || 'Season';
  // Bracket rounds drop the pool-play frames (overall standings + pool columns) in favor
  // of head-to-head matchups — nobody needs pool play score updates once the bracket runs.
  const isPlayoffRound = ['QF', 'SF', 'Finals'].includes(currentRound);

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

  // ---- Formatters ----
  // Whole-point totals (no partial pitcher innings) drop the redundant ".0".
  const fmt = (n) => {
    const s = n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const rankEmoji = ['\u{1F947}', '\u{1F948}', '\u{1F949}']; // 🥇🥈🥉
  const rank = (i) => (i < 3 ? rankEmoji[i] : `${i + 1}.`);
  const rankPool = (i) => (i === 0 ? '\u{1F947}' : `${i + 1}.`); // 🥇 for pool leader only
  const heart = (n) => (Math.floor(n) === 69 ? ' ❤️' : ''); // ❤️ easter egg at 69
  const dumpster = '\u{1F5D1}️\u{1F4A6}'; // 🗑️💦 last place

  // ---- Standings text: bracket matchups for playoff rounds, overall + pool columns
  // for pool play. Pool-play scaffolding (winner sets, wildcards, legend) is only
  // computed when it is actually shown.
  let playoffText = null;
  let overallText = '';
  let poolText = '';
  let legendText = null;
  if (isPlayoffRound) {
    playoffText = buildPlayoffMatchupsSlackText(seasonData, currentRound, { final: !!summaryRound });
    if (!playoffText) {
      // No confirmed_seeding snapshot yet (pool play not ended in the app) — degrade to a
      // plain ranked list of this round's totals rather than resurrecting pool-play frames.
      const rows = computeRoundScores(batting, pitching, [currentRound], seasonData).sort((a, b) => b.total - a.total);
      playoffText =
        `*\u{1F3C6} ${currentRoundLabel} Standings*\n` +
        (rows.length
          ? rows.map((m, i) => `${rank(i)} ${m.manager} — ${fmt(m.total)}${heart(m.total)}`).join('\n')
          : '_No scores recorded yet._');
    }
  } else {
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
    const ppOverall = computeRoundScores(batting, pitching, ['PP1', 'PP2'], seasonData).sort(
      (a, b) => b.total - a.total
    );
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

    // ---- Build overall standings text ----
    overallText = overall.length
      ? overall
          .map((m, i) => {
            const d = dot(m.manager, 'overall');
            const nameStr = d !== null ? `*${m.manager}*` : m.manager;
            const dotStr = d ? `${d} ` : '';
            const trash = m.manager === overallLastMgr ? ` ${dumpster}` : '';
            return `${rank(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)}`;
          })
          .join('\n')
      : '_No scores recorded yet._';

    // ---- Build pool text (combined into one string for the right column) ----
    const sortedPoolEntries = Object.entries(pools).sort((a, b) => a[0].localeCompare(b[0]));
    poolText = sortedPoolEntries
      .map(([poolName, members]) => {
        const poolLastMgr = members.length > 0 ? members[members.length - 1].manager : null;
        const lines = members
          .map((m, i) => {
            const d = dot(m.manager, currentRound);
            const dotStr = d ? `${d} ` : '';
            const nameStr = i === 0 ? `*${m.manager}*` : m.manager;
            const trash = m.manager === poolLastMgr ? ' \u{1F4A9}' : '';
            return `${rankPool(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)}`;
          })
          .join('\n');
        return `*${poolName}*\n${lines}`;
      })
      .join('\n\n');

    // Color legend shown during pool play rounds when leaders are determined
    if (['PP1', 'PP2'].includes(currentRound) && (pp1WinnerSet.size > 0 || pp2WinnerSet.size > 0)) {
      const parts = [];
      if (pp1WinnerSet.size > 0) parts.push('\u{1F7E2} PP1 Pool Leader');
      if (pp2WinnerSet.size > 0) parts.push('\u{1F535} PP2 Pool Leader');
      if (pp1WinnerSet.size > 0 && pp2WinnerSet.size > 0) parts.push('\u{1F537} Both');
      if (wildcardSet.size > 0) parts.push('\u{1F7E1} Wild Card');
      parts.push(`${dumpster} Last Place`);
      legendText = parts.join('  ·  ');
    }
  }

  // ---- Assemble blocks ----
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: `⚾ WMMC Scoreboard — ${year}`, emoji: true } });

  // Slack collapses long messages and clips the bottom behind a "View Full Message" link,
  // so this can't live at the end of the message — put it right under the header where it
  // always renders, regardless of how long the rest of the post gets.
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '\u{1F517} View full scoreboard: <http://wmmc.live|wmmc.live>' }],
  });

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

  if (summaryRound) {
    // Wrap-up post on the Monday after the round's last games — the round is over,
    // so lead with "final results", not a current-period countdown.
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\u{1F3C1} *${currentRoundLabel} — complete! Final results below.*` },
    });
  } else {
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
  }

  // Color legend shown during pool play rounds when leaders are determined
  if (legendText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: legendText }] });
  }

  // ---- Standings: playoff rounds get head-to-head matchups; pool play keeps the
  // overall (left) + pool (right) 2-column layout ----
  blocks.push({ type: 'divider' });
  if (isPlayoffRound) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: playoffText } });
  } else if (currentRound && poolText) {
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

  // ---- Playoff odds (PP2 Week 4–5 only) ----
  // Reads the stored sd.playoff_odds (computed by the 4am sync / 7am post),
  // so the Slack numbers always match the scoreboard UI's.
  const oddsText = buildPlayoffOddsSlackText(seasonData, todayISO);
  if (oddsText) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: oddsText } });
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
    const { topManagers, bottomManagers, topPlayers, bottomPlayers, worstPlayerOverall } = dailyHL;

    const fmtMgr = (m, i, isBottom) => {
      const label = isBottom ? `${i + 1}.` : rankEmoji[i] || `${i + 1}.`;
      // Slack mrkdwn has no text-align support and collapses regular spaces, so fake an
      // indent with non-breaking spaces to line this row up under the name instead of
      // flush-left under the rank label above it.
      return `${label} *${m.manager}* — ${fmt(m.total)}\n\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0_(B: ${fmtInt(m.batting)} | P: ${fmt(m.pitching)})_`;
    };
    // Strikeout-milestone badges for hitless batters on the Worst Player Days list:
    // 3 K = hat trick, 4 K = golden sombrero, 5+ K = platinum sombrero.
    // Golden/platinum sombrero use the workspace's custom :gold:/:platinum:/:sombrero: emoji.
    const strikeoutBadge = (so) => {
      if (so >= 5) return ` :platinum: :sombrero:`; // platinum sombrero
      if (so >= 4) return ` :gold: :sombrero:`; // golden sombrero
      if (so >= 3) return ` \u{1F3A9}\u{1FA84}`; // hat trick
      return '';
    };
    const fmtPlayer = (p, i, isBottom) => {
      const label = isBottom ? `${i + 1}.` : rankEmoji[i] || `${i + 1}.`;
      const typeAbbrev = p.type === 'Batter' ? 'B' : 'P';
      const mgrShort = shortMgrNames[p.manager] || p.manager;
      const badge = isBottom && p.type === 'Batter' ? strikeoutBadge(p.so || 0) : '';
      return `${label} *${p.name}* - ${typeAbbrev} (${mgrShort}) — ${fmt(p.score)}${badge}`;
    };

    // When nobody hits the strict "bad day" bar (see worstPlayers filter in
    // computeDailyHighLow), roast the day's single worst performance and worst manager
    // instead of showing an empty list. Picked deterministically from the date so
    // reloading the same day's post doesn't reroll the joke. Roasts the chosen player and
    // ONLY that player's own manager (never a different manager) — picking whichever
    // available stat makes the funniest joke: a pitcher walking guys > a batter leaving
    // men on base > a batter striking out > just a plain low score.
    const walkRoasts = [
      (p, mgrShort) =>
        `*${p.name}* walked ${p.bb} batters on his way to a ${fmt(p.score)}-pt day — the man can't commit to a strike zone any more than he can commit to anything else. *${mgrShort}* keeps handing him the ball anyway.`,
      (p, mgrShort) =>
        `${p.bb} free passes and a ${fmt(p.score)}-pt line from *${p.name}* — that's not pitching, that's just walking out on people. *${mgrShort}* rostered him anyway.`,
      (p, mgrShort) =>
        `*${p.name}* left ${p.bb} batters standing at first for a ${fmt(p.score)}-pt day — dude bails on commitments more than he throws strikes. *${mgrShort}*, maybe it's time for an intervention.`,
      (p, mgrShort) =>
        `Breaking: *${p.name}* has located ball four ${p.bb} times but not the strike zone, good for a ${fmt(p.score)}-pt day. *${mgrShort}* keeps trotting him out there like GPS is coming any minute.`,
      (p, mgrShort) =>
        `${p.bb} walks issued, ${fmt(p.score)} pts earned — *${p.name}* is basically running a free youth clinic on how to get to first without trying. *${mgrShort}* is the head sponsor.`,
      (p, mgrShort) =>
        `*${p.name}* handed out ${p.bb} walks like they were Halloween candy for a ${fmt(p.score)}-pt line. *${mgrShort}* forgot to lock the front door on this roster spot.`,
      (p, mgrShort) =>
        `SportsCenter's Not-Top-10: *${p.name}* issuing ${p.bb} walks for a ${fmt(p.score)}-pt day, a masterclass in throwing everywhere except where it counts. *${mgrShort}* rostered him on purpose.`,
      (p, mgrShort) =>
        `${p.bb} batters got a courtesy escort to first from *${p.name}* today, netting a robust ${fmt(p.score)} pts. *${mgrShort}* is out here running a taxi service, not a pitching staff.`,
      (p, mgrShort) =>
        `*${p.name}* walked ${p.bb} and pitched to a ${fmt(p.score)}-pt day, proving once again that control is a lifestyle choice he simply hasn't made. *${mgrShort}* remains a believer.`,
      (p, mgrShort) =>
        `${p.bb} walks is a lot of free real estate to give away for ${fmt(p.score)} pts, and *${p.name}* gave it away like it was rent-controlled. *${mgrShort}* signed the lease.`,
    ];
    const lobRoasts = [
      (p, mgrShort) =>
        `*${p.name}* left ${p.lob} men on base in a ${fmt(p.score)}-pt nothing of a day — the guy abandons runners like it's a bad camping trip. *${mgrShort}* rostered him anyway.`,
      (p, mgrShort) =>
        `${p.lob} runners stranded for only ${fmt(p.score)} pts — *${p.name}* really said "every man for himself" out there. *${mgrShort}*'s guy is loyal to absolutely no one on base.`,
      (p, mgrShort) =>
        `*${p.name}* posted ${fmt(p.score)} pts while leaving ${p.lob} men on base — a real love-'em-and-leave-'em day. *${mgrShort}* should look into couples counseling for this roster spot.`,
      (p, mgrShort) =>
        `${p.lob} men stranded and a ${fmt(p.score)}-pt line from *${p.name}* — a wildly inefficient way to lose. *${mgrShort}* watched runners die on base like it was a group activity.`,
      (p, mgrShort) =>
        `*${p.name}* had ${p.lob} guys standing around waiting for a ride home and never called the Uber, good for ${fmt(p.score)} pts. *${mgrShort}* is footing the cancellation fee.`,
      (p, mgrShort) =>
        `SportsCenter's runner-abandonment leaderboard: *${p.name}*, ${p.lob} left on base, ${fmt(p.score)} pts. *${mgrShort}* nodded along like this was the plan all along.`,
      (p, mgrShort) =>
        `${p.lob} men on base and *${p.name}* couldn't bring a single one home, settling for ${fmt(p.score)} pts. *${mgrShort}*'s guy treats ducks on the pond like decorations.`,
      (p, mgrShort) =>
        `*${p.name}* went ${fmt(p.score)} pts today with ${p.lob} runners stranded — a real "it's not you, it's me" performance. *${mgrShort}* is the one left holding the bag.`,
      (p, mgrShort) =>
        `${p.lob} men left on base is basically a graveyard, and *${p.name}* dug it for only ${fmt(p.score)} pts. *${mgrShort}* brought the shovel.`,
      (p, mgrShort) =>
        `*${p.name}* stranded ${p.lob} runners in a ${fmt(p.score)}-pt day, which is a lot of unfinished business for one afternoon. *${mgrShort}* is used to the loose ends by now.`,
    ];
    const strikeoutRoasts = [
      (p, mgrShort) =>
        `*${p.name}* struck out ${p.so} times in a ${fmt(p.score)}-pt day, the offensive equivalent of running in place. *${mgrShort}* still gets credit for owning the league's quietest disaster.`,
      (p, mgrShort) =>
        `${p.so} strikeouts and ${fmt(p.score)} pts from *${p.name}* — not a hat trick, just a guy swinging at nothing. *${mgrShort}* watched the whole thing happen.`,
      (p, mgrShort) =>
        `*${p.name}* took ${p.so} called strolls back to the dugout today for a ${fmt(p.score)}-pt line. *${mgrShort}* keeps writing his name on the lineup card anyway.`,
      (p, mgrShort) =>
        `${p.so} strikeouts is a lot of practice swings to show for ${fmt(p.score)} pts. *${p.name}* is out here auditioning for a golf swing tutorial. *${mgrShort}* bought a ticket.`,
      (p, mgrShort) =>
        `SportsCenter Not Top 10: *${p.name}* whiffing ${p.so} times for ${fmt(p.score)} pts, a real "see ball, miss ball" showcase. *${mgrShort}* is the proud general manager of this act.`,
      (p, mgrShort) =>
        `*${p.name}* struck out ${p.so} times and produced a ${fmt(p.score)}-pt line — a masterclass in showing up to not participate. *${mgrShort}* clapped anyway.`,
      (p, mgrShort) =>
        `${p.so} strikeouts, ${fmt(p.score)} pts, and *${p.name}* still hasn't figured out the bat makes contact with the ball, not the air around it. *${mgrShort}* remains hopeful for no good reason.`,
      (p, mgrShort) =>
        `*${p.name}* went down swinging ${p.so} times today for ${fmt(p.score)} pts, a personal fireworks show with no actual fireworks. *${mgrShort}* is footing the bill.`,
    ];
    const flatRoasts = [
      (p, mgrShort) =>
        `*${p.name}* turned in the league's flattest line today at ${fmt(p.score)} pts — not bad enough to be funny, just bad enough to notice. *${mgrShort}* will pretend not to see this.`,
      (p, mgrShort) =>
        `Nobody bombed today, so *${p.name}*'s ${fmt(p.score)}-pt nothingburger gets the spotlight by default. *${mgrShort}* still owns it.`,
      (p, mgrShort) =>
        `*${p.name}* posted a quiet, unremarkable ${fmt(p.score)} pts — the fantasy equivalent of a background extra. *${mgrShort}* still has to explain this roster spot to somebody.`,
      (p, mgrShort) =>
        `In a day with no real disasters, *${p.name}*'s ${fmt(p.score)} pts wins by default, like the last slice of gas-station pizza. *${mgrShort}* is the one who ordered it.`,
      (p, mgrShort) =>
        `*${p.name}* did absolutely nothing today, statistically speaking — ${fmt(p.score)} pts of pure beige. *${mgrShort}* rostered a beige wall and called it a plan.`,
      (p, mgrShort) =>
        `SportsCenter's slowest news day features *${p.name}* posting ${fmt(p.score)} pts, which is the box-score equivalent of dead air. *${mgrShort}* is the producer who let it happen.`,
      (p, mgrShort) =>
        `*${p.name}*'s ${fmt(p.score)}-pt day is the roster equivalent of elevator music — technically present, forgotten immediately. *${mgrShort}* keeps it on repeat.`,
    ];
    const worstPlayerText = (() => {
      if (bottomPlayers.length) return bottomPlayers.map((p, i) => fmtPlayer(p, i, true)).join('\n');
      if (!worstPlayerOverall) return '_None today_';
      const p = worstPlayerOverall;
      const mgrShort = shortMgrNames[p.manager] || p.manager;
      const seed = yesterdayET.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      let bank;
      if (p.type === 'Pitcher' && (p.bb || 0) >= 2) bank = walkRoasts;
      else if (p.type === 'Batter' && (p.lob || 0) >= 2) bank = lobRoasts;
      else if (p.type === 'Batter' && (p.so || 0) >= 1) bank = strikeoutRoasts;
      else bank = flatRoasts;
      return bank[seed % bank.length](p, mgrShort);
    })();

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
          text: `\u{1F3C6} *Barely Competent*\n${topManagers.map((m, i) => fmtMgr(m, i, false)).join('\n')}`,
        },
        {
          type: 'mrkdwn',
          text: `\u{1F5D1}️ *Monkeys Trying to Fuck a Loose Couch*\n${bottomManagers.map((m, i) => fmtMgr(m, i, true)).join('\n')}`,
        },
      ],
    });
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `\u{2B50} *Have a Day, Kid*\n${topPlayers.map((p, i) => fmtPlayer(p, i, false)).join('\n')}`,
        },
        {
          type: 'mrkdwn',
          text: `\u{1F4C9} *Yankees Since '10*\n${worstPlayerText}`,
        },
      ],
    });
  }

  // ---- Submission window (Friday before a playoff round's Monday first pitch only) ----
  // Deliberately last: it is a call to action, so it reads after the scores rather than
  // pushing them down. Empty string on every other day.
  const submissionBlock = buildSubmissionWindowBlock(seasonData, todayISO);
  if (submissionBlock) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: submissionBlock } });
  }

  return {
    blocks,
    text: `⚾ WMMC Scoreboard (${year}) — ${currentRoundLabel}${summaryRound ? ' Final' : ''} | wmmc.live`,
    // The period this post is framed for — null when it could not be determined and the
    // blocks above are therefore the pool-play shell. Callers gate on it before sending.
    round: currentRound || null,
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

  // Collect every manager's claim on each (weekKey, player) BEFORE writing, then store the widest
  // window any of them had. player_dates holds one window per player per week, but a player can
  // change hands MID-WEEK (a trade: dropped by A on the 28th — his last rostered, still-scoring day
  // — and added by B on the 29th). Writing each claim straight into the shared slot let the last
  // one seen win, so one side of the handover was thrown away and the shared weekly row was then
  // recomputed against a window its points never sat in: A's drop-day points were erased from the
  // database outright. Worse, nothing orders those writes, so which side survived depended on
  // manager key order. Merging keeps every day somebody rostered him; managerWeekSubtotal splits
  // those days back out per manager so neither owner is credited for the other's days.
  // (Mirrors mergeWeekWindows / managerWeekWindow in js/eligibility.js — keep in sync.)
  const merged = {}; // weekKey -> player -> { start, end, whole } | null
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

        if (!merged[weekKey]) merged[weekKey] = {};
        const cur = merged[weekKey][player];
        if (cur && cur.whole) continue; // a whole-week claim swallows every narrower one
        if (!needsStart && !needsEnd) {
          merged[weekKey][player] = { whole: true };
          continue;
        }
        const start = needsStart ? dates.add_date : null;
        const end = needsEnd ? dates.drop_date : null;
        if (!cur) {
          merged[weekKey][player] = { start, end };
          continue;
        }
        cur.start = cur.start === null || start === null ? null : start < cur.start ? start : cur.start;
        cur.end = cur.end === null || end === null ? null : end > cur.end ? end : cur.end;
      }
    }
  }

  for (const [weekKey, players] of Object.entries(merged)) {
    for (const [player, window] of Object.entries(players)) {
      if (window.whole || (!window.start && !window.end)) continue;
      const entry = { start: window.start || null, end: window.end || null, auto: true };
      for (const type of ['batter', 'pitcher']) {
        if (!sd.player_dates[weekKey]) sd.player_dates[weekKey] = {};
        if (!sd.player_dates[weekKey][type]) sd.player_dates[weekKey][type] = {};
        const existing = sd.player_dates[weekKey][type][player];
        if (existing && !existing.auto) continue; // preserve manual commissioner override
        sd.player_dates[weekKey][type][player] = entry;
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

  // Refresh the per-manager split for every week just recomputed — a swap approval or a save is
  // exactly when a player changes hands mid-week, and the split has to land with the same write.
  const touchedWeeks = new Set(
    [...toRecompute].map((key) => key.slice(0, key.lastIndexOf('|', key.lastIndexOf('|') - 1)))
  );
  for (const weekKey of touchedWeeks) {
    const wkParts = weekKey.split('|');
    applyManagerScoreSplits(sd, wkParts[0], wkParts.slice(1).join('|'));
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

// Find the manager who rostered a player ON a specific date, from the date windows.
// findManagerForPlayerWeek (below) reads the per-week roster ARRAY, which answers "who holds him
// now" — the wrong question for a day already played. A swap removes the outgoing player from the
// array the moment it is applied, so his final rostered day (drop_date is INCLUSIVE) lost its owner
// and his points for that day vanished from the daily leaderboard entirely — the manager showed 0
// for a day his pitcher had just thrown seven innings. Windows are period-scoped, and a drop ON the
// date still counts that date. Falls back to the array lookup for players with no date events at
// all (an initial-submission roster that predates roster_dates).
function findManagerForPlayerDate(sd, playerName, type, round, week, date) {
  if (!date) return findManagerForPlayerWeek(sd, playerName, type, round, week);
  const periodStart = periodStartForRound(sd, round);
  for (const [manager, weeks] of Object.entries(sd.roster_dates || {})) {
    let latestAdd = null;
    let latestDrop = null;
    for (const players of Object.values(weeks || {})) {
      const d = (players || {})[playerName];
      if (!d) continue;
      if (
        d.add_date &&
        (!periodStart || d.add_date >= periodStart) &&
        d.add_date <= date &&
        (!latestAdd || d.add_date > latestAdd)
      ) {
        latestAdd = d.add_date;
      }
      if (
        d.drop_date &&
        (!periodStart || d.drop_date >= periodStart) &&
        d.drop_date < date &&
        (!latestDrop || d.drop_date > latestDrop)
      ) {
        latestDrop = d.drop_date;
      }
    }
    if (latestAdd && (!latestDrop || latestAdd > latestDrop)) return manager;
  }
  return findManagerForPlayerWeek(sd, playerName, type, round, week);
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

// Derive every manager's roster for one schedule week, as of a given day, from the date windows.
//
// This is the roster answer the live views must use. The findManagerForPlayer* helpers above read
// the sd.rosters ARRAYS, which are a derived cache: findManagerForPlayerWeek only sees the current
// week key (usually empty on this league, since rosters are tracked via roster_dates), and
// findManagerForPlayer scans EVERY week of the season — so during the playoffs it happily
// attributes a player to a manager who was eliminated two rounds ago. Deriving from roster_dates
// scoped to the period (periodStartForRound) is the invariant's source of truth and drops
// eliminated managers naturally: they have no add inside the current period.
//
// asOf must be the live day, not the week's end — a SCHEDULED (future-dated) swap is recorded the
// moment it's submitted, so bounding by the week end applies it early, dropping a player who is
// still rostered and still scoring. Mirrors rebuildRosterArraysFromDates and managerWeekSubtotal's
// eligibility, so the live views agree with the Scoreboard.
//
// Returns { managerBatters, managerPitchers, managerByPlayer, rosterWindowByPlayer }, where
// managerByPlayer is keyed `${lowercasedName}::${'batting'|'pitching'}` (so a two-way player
// resolves per role) and rosterWindowByPlayer is keyed by lowercased name.
function buildWeekRostersFromDates(sd, round, week, asOf) {
  const managerBatters = {}; // manager -> string[]
  const managerPitchers = {}; // manager -> string[]
  const managerByPlayer = {};
  const rosterWindowByPlayer = {};
  if (!round || !week) return { managerBatters, managerPitchers, managerByPlayer, rosterWindowByPlayer };

  const weekKey = `${round}|${week}`;
  const batPool = new Set(sd.batters_pool || []);
  const pitPool = new Set(sd.pitchers_pool || []);
  // Scope carry-forward to the current period: PP2/QF/SF/Finals each start fresh from their own
  // submission, so a PP1 holdover with no drop must not appear here. null = PP1 (no bound).
  const periodStart = periodStartForRound(sd, round);
  const allManagerNames = new Set([...Object.keys(sd.rosters || {}), ...Object.keys(sd.roster_dates || {})]);

  for (const manager of allManagerNames) {
    // Build add/drop history first so we can filter both the stored arrays and the roster_dates
    // additions with the same drop logic. Without this, stored roster arrays from earlier carries
    // included dropped players. Constrain to the current period so prior-period adds don't leak.
    const mgrDates = (sd.roster_dates || {})[manager];
    const latestAdd = {};
    const latestDrop = {};
    if (mgrDates && typeof mgrDates === 'object') {
      for (const players of Object.values(mgrDates)) {
        if (!players || typeof players !== 'object') continue;
        for (const [p, d] of Object.entries(players)) {
          if (
            d.add_date &&
            (!periodStart || d.add_date >= periodStart) &&
            (!asOf || d.add_date <= asOf) &&
            (!latestAdd[p] || d.add_date > latestAdd[p])
          ) {
            latestAdd[p] = d.add_date;
          }
          if (
            d.drop_date &&
            (!periodStart || d.drop_date >= periodStart) &&
            (!asOf || d.drop_date <= asOf) &&
            (!latestDrop[p] || d.drop_date > latestDrop[p])
          ) {
            latestDrop[p] = d.drop_date;
          }
        }
      }
    }
    // In a new period (periodStart set), a player must have a current-period add to be rostered;
    // a PP1 holdover with no drop has no latestAdd entry after period scoping and is excluded.
    //
    // drop_date is INCLUSIVE — the last day the player is rostered and still scores. That is the
    // whole point of the effective-tomorrow swap shape (`drop_date = today, add_date = tomorrow`):
    // the outgoing player's team already played today, so he keeps today's points. A player whose
    // drop lands ON the day being shown is therefore still rostered FOR that day, even though he is
    // gone "as of now" — so `latestDrop[p] >= asOf` keeps him in the list, and the per-date guard
    // (isDateEligibleForPlayer) does the day-level gating it already exists for.
    const isRosteredForDay = (p) => {
      if (!latestAdd[p]) return !periodStart && !latestDrop[p];
      if (!latestDrop[p] || latestAdd[p] > latestDrop[p]) return true;
      return !!asOf && latestDrop[p] >= asOf;
    };

    // Seed from stored arrays, but strip any player dropped before the day being shown.
    const stored = (sd.rosters && sd.rosters[manager] && sd.rosters[manager][weekKey]) || {};
    const bats = (stored.batters || []).filter(isRosteredForDay);
    const pits = (stored.pitchers || []).filter(isRosteredForDay);

    // Add players known only from roster_dates (not already present via stored arrays).
    for (const p of Object.keys(latestAdd)) {
      if (!isRosteredForDay(p)) continue;
      const inBat = batPool.has(p);
      const inPit = pitPool.has(p);
      if (inBat && !inPit) {
        if (!bats.includes(p)) bats.push(p);
      } else if (inPit && !inBat) {
        if (!pits.includes(p)) pits.push(p);
      }
      // both/neither pool: can't classify confidently — rely on the stored arrays.
    }

    if (bats.length || pits.length) {
      managerBatters[manager] = bats;
      managerPitchers[manager] = pits;
      for (const p of [...bats, ...pits]) {
        rosterWindowByPlayer[p.toLowerCase()] = { add: latestAdd[p] || null, drop: latestDrop[p] || null };
      }
    }
  }

  for (const [m, names] of Object.entries(managerBatters)) {
    for (const n of names) managerByPlayer[`${n.toLowerCase()}::batting`] = m;
  }
  for (const [m, names] of Object.entries(managerPitchers)) {
    for (const n of names) managerByPlayer[`${n.toLowerCase()}::pitching`] = m;
  }

  return { managerBatters, managerPitchers, managerByPlayer, rosterWindowByPlayer };
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
      so: parseNum(findCol(row, ['so', 'SO', 'k', 'K', 'strikeouts']) || 0),
      lob: parseNum(findCol(row, ['lob', 'LOB', 'left_on_base', 'leftOnBase']) || 0),
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
// ============================================================
// Late MLB stat corrections
// ============================================================
// MLB revises box scores after the fact — a hit reclassified as an error, an RBI credited days
// later. The existing catch-up only ever re-syncs the current week and the one before it, and only
// within the same phase (resolveWeeksForCatchUp), so a correction landing on a week that has since
// closed is never picked up. Three such corrections were sitting in the 2026 season: +5, +2 and
// -0.6 across three managers in weeks that finished months earlier.
//
// THE POLICY, and why there is a ceiling.
//
// A real stat correction is small. When a re-sync of a completed week wants to move a manager by
// tens of points, that is not MLB revising a box score — it is a bug. We know because we hit one: a
// rained-out game made up in July was being counted in its original May week, worth ~34 points to a
// single manager, and it looked exactly like "missing points" until the gamePk was opened.
//
// So corrections within MLB_CORRECTION_MAX_SWING are applied automatically, and anything larger is
// REFUSED and flagged for a human. Auto-applying big swings is how a bug gets silently written into
// the league's history; refusing them is how it gets noticed.
const CORRECTION_MAX_SWING = Number(process.env.MLB_CORRECTION_MAX_SWING || 15);

// Per-manager total differences between two score snapshots, largest first.
function totalsDelta(before, after) {
  const out = [];
  for (const manager of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[manager] && before[manager].total) || 0;
    const a = (after[manager] && after[manager].total) || 0;
    if (Math.abs(a - b) >= 0.01) out.push({ manager, before: r2s(b), after: r2s(a), diff: r2s(a - b) });
  }
  return out.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
}

// Move one week's stat rows from a synced clone into the live season. Surgical on purpose: only
// rows for that week are touched, so a sweep of one week can never disturb another.
function adoptWeekRows(sd, clone, schedWeek) {
  const isWeek = (r) => r.round === schedWeek.round && r.week === schedWeek.week;
  for (const key of ['weekly_batting', 'weekly_pitching', 'daily_batting', 'daily_pitching']) {
    const kept = (sd[key] || []).filter((r) => !isWeek(r));
    const incoming = (clone[key] || []).filter(isWeek);
    sd[key] = [...kept, ...incoming];
  }
  // Team maps are cumulative and safe to merge — a trade recorded during the sync should stick.
  Object.assign(sd.batters_team || (sd.batters_team = {}), clone.batters_team || {});
  Object.assign(sd.pitchers_team || (sd.pitchers_team = {}), clone.pitchers_team || {});
}

// ============================================================
// Did a correction change a RESULT, or only a number?
// ============================================================
// A stat correction that moves a manager 2.4 points is not news. A stat correction that hands a
// pool to someone else, moves a manager across the wildcard cut, or flips a quarterfinal is news
// the commissioner has to act on — the bracket, the Hall of Fame and the roasts all read from
// those outcomes. So the sweep posts to Slack ONLY when one of them changes, and stays silent
// otherwise. Point totals moving is the expected case; posting it every Wednesday would train
// everyone to ignore the channel.
//
// No new seeding or bracket logic here. `currentQualification` (the playoff-odds engine) already
// owns "who wins each pool and who qualifies", and `computePlayoffPairs` (the Slack matchup post)
// already owns "who played whom and who won". Both are re-used verbatim, so a correction alert can
// never disagree with the bracket it is describing. The ESM `js/seeding.js` / `js/bracket.js`
// copies are the client's; `server.js` cannot import them, and a third copy is exactly what
// CLAUDE.md warns about.
function captureRoundOutcomes(db, sd) {
  const managers = (db.managers || []).filter((m) => m.active !== false && m.pool);
  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];

  const roundTotals = (round) => {
    const out = {};
    for (const row of computeRoundScores(batting, pitching, [round], sd)) out[row.manager] = row.total;
    return out;
  };

  const poolWinners = {};
  let qualifiers = [];
  if (managers.length) {
    const pp1 = roundTotals('PP1');
    const pp2 = roundTotals('PP2');
    const qual = currentQualification(
      managers.map((m) => ({ manager: m.name, pool: m.pool, pp1: pp1[m.name] || 0, pp2: pp2[m.name] || 0 }))
    );
    for (const [pool, w] of Object.entries(qual.pp1LeaderByPool)) poolWinners[`PP1|${pool}`] = w.manager;
    for (const [pool, w] of Object.entries(qual.pp2LeaderByPool)) poolWinners[`PP2|${pool}`] = w.manager;
    qualifiers = qual.qualifierNames;
  }

  // Playoff pairings come off the locked confirmed_seeding snapshot, so they exist only once pool
  // play has been ended in the app. Before that there is nothing here to overturn.
  const matchups = {};
  for (const round of ['QF', 'SF', 'Finals']) {
    const computed = computePlayoffPairs(sd, round);
    if (!computed) continue;
    for (const p of computed.pairs) matchups[p.label] = p.leader;
  }

  return { poolWinners, qualifiers, matchups, seedingLocked: (sd.finalized_rounds || []).includes('PP') };
}

// What changed between two outcome snapshots, as lines a human can read in Slack. Empty array =
// nothing to say.
function diffRoundOutcomes(before, after) {
  const changes = [];

  for (const key of new Set([...Object.keys(before.poolWinners), ...Object.keys(after.poolWinners)])) {
    const [period, pool] = key.split('|');
    const b = before.poolWinners[key] || '(nobody)';
    const a = after.poolWinners[key] || '(nobody)';
    if (b !== a) changes.push(`${pool} ${period} winner: ${b} → ${a}`);
  }

  const wasIn = new Set(before.qualifiers);
  const isIn = new Set(after.qualifiers);
  const droppedOut = before.qualifiers.filter((m) => !isIn.has(m));
  const movedIn = after.qualifiers.filter((m) => !wasIn.has(m));
  if (droppedOut.length || movedIn.length) {
    changes.push(`Qualifiers: in ${movedIn.join(', ') || '—'} · out ${droppedOut.join(', ') || '—'}`);
  } else if (before.qualifiers.join('|') !== after.qualifiers.join('|')) {
    // Same eight, different order — the bracket pairs 1v8/4v5/3v6/2v7 off this order, so a reorder
    // changes who plays whom even though nobody's spot moved.
    changes.push(`Seed order: ${before.qualifiers.join(', ')} → ${after.qualifiers.join(', ')}`);
  }

  for (const label of new Set([...Object.keys(before.matchups), ...Object.keys(after.matchups)])) {
    const b = before.matchups[label] || '(undecided)';
    const a = after.matchups[label] || '(undecided)';
    if (b !== a) changes.push(`${label} winner: ${b} → ${a}`);
  }

  return changes;
}

// Sweep completed weeks for late corrections.
//
// Each week is synced into its own clone and measured before anything is adopted, so a week whose
// movement exceeds the ceiling is simply discarded — the live season never sees it. `apply: false`
// makes the whole thing a report.
//
// Accepted weeks are always adopted into a `target` season object. When applying, that IS `sd`;
// on a dry run it is a throwaway deep clone, so the report can still answer "would this change a
// result?" without the live season ever seeing the rows. Pass `db` to get that answer back as
// `outcomeChanges` — see captureRoundOutcomes.
//
// Returns { results, outcomeChanges }. `outcomeChanges` is null when no `db` was supplied and an
// empty array when the corrections moved only point totals.
async function sweepStatCorrections(sd, { todayISO, threshold = CORRECTION_MAX_SWING, apply = true, db = null } = {}) {
  const results = [];
  const target = apply ? sd : JSON.parse(JSON.stringify(sd));
  const outcomesBefore = db ? captureRoundOutcomes(db, target) : null;
  let adopted = 0;

  for (let idx = 0; idx < SEASON_SCHEDULE.length; idx++) {
    const schedWeek = SEASON_SCHEDULE[idx];
    const dates = (sd.schedule_dates || [])[idx];
    if (!dates?.start || !dates?.end) continue;
    // Completed weeks only. The current week is the daily sync's job, and re-syncing it here would
    // just race that.
    if (dates.end >= todayISO) continue;

    const label = `${schedWeek.round} ${schedWeek.week}`;
    let clone;
    try {
      // Measure each week against the season as it stands NOW — `target`, not the original `sd` —
      // so an earlier week's adopted correction is already in the baseline and can't be counted
      // twice.
      clone = JSON.parse(JSON.stringify(target));
      const before = captureScoreSnapshot(clone, todayISO).totals;
      await performMLBSync(clone, schedWeek, dates, { trigger: 'auto', note: 'corrections-sweep' });
      const diffs = totalsDelta(before, captureScoreSnapshot(clone, todayISO).totals);

      if (diffs.length === 0) {
        results.push({ week: label, status: 'clean' });
        continue;
      }
      const maxSwing = Math.max(...diffs.map((d) => Math.abs(d.diff)));
      if (maxSwing > threshold) {
        results.push({ week: label, status: 'flagged', max_swing: maxSwing, diffs });
        continue;
      }
      adoptWeekRows(target, clone, schedWeek);
      adopted++;
      results.push({ week: label, status: apply ? 'applied' : 'would_apply', max_swing: maxSwing, diffs });
    } catch (e) {
      results.push({ week: label, status: 'error', error: e.message });
    }
  }

  let outcomeChanges = null;
  if (outcomesBefore) {
    outcomeChanges = adopted ? diffRoundOutcomes(outcomesBefore, captureRoundOutcomes(db, target)) : [];
  }
  return { results, outcomeChanges };
}

// The Slack post for a correction that overturned something. Kept as its own builder, like the
// other build*SlackText helpers, so the message can be read (and checked) without running a cron.
function buildCorrectionOutcomeSlackText(appliedWeeks, outcomeChanges, seedingLocked) {
  return (
    `:rotating_light: *A late MLB stat correction changed a result.*\n` +
    `Applied to ${appliedWeeks.length} week(s): ${appliedWeeks.join(', ')}.\n` +
    outcomeChanges.map((c) => `\u{2022} ${c}`).join('\n') +
    (seedingLocked
      ? `\n_Pool play is already finalized, so the locked seeding and the live bracket are ` +
        `unchanged — but pool play no longer says what the bracket was built from._`
      : '')
  );
}

// POST /api/mlb/apply-corrections  { year, threshold?, dryRun? }
// Commissioner-run sweep. dryRun reports without writing.
app.post('/api/mlb/apply-corrections', requireCommissioner, async (req, res) => {
  const year = (req.body.year || new Date().getFullYear()).toString();
  const dryRun = !!req.body.dryRun;
  const threshold = req.body.threshold != null ? Number(req.body.threshold) : CORRECTION_MAX_SWING;
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { results, outcomeChanges } = await sweepStatCorrections(sd, {
      todayISO: todayET,
      threshold,
      apply: !dryRun,
      db,
    });
    const applied = results.filter((r) => r.status === 'applied' || r.status === 'would_apply');
    const flagged = results.filter((r) => r.status === 'flagged');

    if (!dryRun && applied.length) {
      addAuditEntry(db, 'mlb_corrections_applied', {
        year,
        threshold,
        weeks: applied.map((r) => r.week),
        outcome_changes: outcomeChanges,
      });
      db.seasons[year] = sd;
      writeDB(db);
    }
    res.json({
      ok: true,
      dry_run: dryRun,
      threshold,
      applied: applied.length,
      flagged: flagged.length,
      outcome_changes: outcomeChanges,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mlb/resync-dryrun — what a re-sync WOULD do, without doing any of it.
// Body: { year, round, week? }   (omit `week` to dry-run every week of the round)
//
// The premise worth testing: if the scoring logic is right, re-syncing a completed week from the
// source data should reproduce the scores already stored. Any movement is either a real MLB stat
// correction or a bug — and either way it is something to look at BEFORE it is written to the
// league's history, not after.
//
// So this runs the genuine path — performMLBSync, the same function the real sync calls, with the
// same weekly rebuild and the same roster-window clipping — against a DEEP COPY of the season, and
// reports the per-manager and per-player differences. The copy is discarded; nothing is persisted.
//
// This is deliberately not /api/mlb/compare, which is a much rougher instrument: compare scores the
// whole week unclipped via enrichBatting, so a mid-week swap shows up there as a large phantom
// difference that a real re-sync would never produce. Reading those numbers as a scoring prediction
// is a mistake this endpoint exists to prevent.
app.post('/api/mlb/resync-dryrun', requireCommissioner, async (req, res) => {
  const { year, round, week } = req.body || {};
  if (!year || !round) return res.status(400).json({ error: 'year and round are required' });
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const weeks = SEASON_SCHEDULE.map((schedWeek, idx) => ({ schedWeek, idx })).filter(
    ({ schedWeek }) => schedWeek.round === round && (!week || schedWeek.week === week)
  );
  if (weeks.length === 0) {
    return res.status(400).json({ error: `No schedule slot for ${round}${week ? ` / ${week}` : ''}` });
  }

  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // The whole point: operate on a copy. Nothing below can reach the stored season.
    const clone = JSON.parse(JSON.stringify(sd));
    const before = captureScoreSnapshot(clone, todayET).totals;
    const beforeRows = new Map();
    for (const r of clone.weekly_batting || []) {
      beforeRows.set(`b\0${r.round}\0${r.week}\0${r.batter}`, r.weekly_score || 0);
    }
    for (const r of clone.weekly_pitching || []) {
      beforeRows.set(`p\0${r.round}\0${r.week}\0${r.pitcher}`, r.weekly_score || 0);
    }

    const synced = [];
    for (const { schedWeek, idx } of weeks) {
      const dates = (clone.schedule_dates || [])[idx];
      if (!dates?.start || !dates?.end) {
        return res.status(400).json({ error: `No schedule dates for ${schedWeek.round} ${schedWeek.week}` });
      }
      const r = await performMLBSync(clone, schedWeek, dates, { trigger: 'dry-run', note: 'resync-dryrun' });
      synced.push({ week: `${schedWeek.round} ${schedWeek.week}`, games: r.games_fetched });
    }

    const after = captureScoreSnapshot(clone, todayET).totals;

    const managers = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const managerDiffs = managers
      .map((manager) => {
        const b = (before[manager] && before[manager].total) || 0;
        const a = (after[manager] && after[manager].total) || 0;
        return { manager, stored_total: r2s(b), resync_total: r2s(a), diff: r2s(a - b) };
      })
      .filter((m) => Math.abs(m.diff) >= 0.01)
      .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

    // Which individual stat rows moved — the material for diagnosing a difference rather than
    // just noticing one.
    const playerDiffs = [];
    const collect = (rows, prefix, nameKey) => {
      for (const r of rows || []) {
        if (!weeks.some(({ schedWeek }) => schedWeek.round === r.round && schedWeek.week === r.week)) continue;
        const key = `${prefix}\0${r.round}\0${r.week}\0${r[nameKey]}`;
        const was = beforeRows.has(key) ? beforeRows.get(key) : null;
        const now = r.weekly_score || 0;
        if (was === null || Math.abs(now - was) >= 0.01) {
          playerDiffs.push({
            player: r[nameKey],
            type: prefix === 'b' ? 'batting' : 'pitching',
            round: r.round,
            week: r.week,
            manager: r.manager || null,
            stored: was,
            resync: r2s(now),
            diff: was === null ? null : r2s(now - was),
            note: was === null ? 'row did not exist before' : undefined,
          });
        }
      }
    };
    collect(clone.weekly_batting, 'b', 'batter');
    collect(clone.weekly_pitching, 'p', 'pitcher');
    playerDiffs.sort((x, y) => Math.abs(y.diff || 0) - Math.abs(x.diff || 0));

    res.json({
      dry_run: true,
      persisted: false,
      weeks_synced: synced,
      managers_moved: managerDiffs.length,
      manager_diffs: managerDiffs,
      player_rows_moved: playerDiffs.length,
      player_diffs: playerDiffs.slice(0, 100),
      verdict:
        managerDiffs.length === 0
          ? 'clean — a real re-sync would not move any manager total'
          : 'movement detected — investigate before syncing for real',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mlb/backfill-unscored — fill RECORDED-BUT-UNSCORED stat fields on an existing week.
// Body: { year, round, week }
//
// Some early weeks were stored without the stat fields the rubric does not score — batting so/lob/
// abs and pitching gs. Nothing in SCORING reads them, so their absence costs no points, but the
// What If Scoring Lab (which can put a value on them), the Player Explorer and the season
// accolades all read them, and a whole round of zeros makes those features silently useless.
//
// Deliberately NOT a re-sync. performMLBSync rebuilds weekly rows and recomputes weekly_score,
// which risks moving real pool-play totals months after the fact. This writes ONLY the unscored
// fields on rows that already exist, never weekly_score, and never creates or deletes a row — so
// by construction it cannot change a single manager's score.
//
// That claim is not left to construction alone: per-manager totals are captured before and after
// and the write is ABORTED if any of them moved. See CLAUDE.md — anything touching stat rows owes
// a before/after totals comparison.
app.post('/api/mlb/backfill-unscored', requireCommissioner, async (req, res) => {
  const ctx = resolveMLBWeek(req, true);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  const { db, sd, year, round, week, dates } = ctx;

  const BAT_FIELDS = ['so', 'lob', 'abs'];
  const PIT_FIELDS = ['gs'];

  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const before = captureScoreSnapshot(sd, todayET).totals;

    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end, buildIdToWmmcName(sd));
    const { batting, pitching } = aggregatePerGame(gameRecords);

    const filled = { batting: 0, pitching: 0 };
    const skippedManual = [];

    const fill = (rows, nameKey, source, fields, counterKey) => {
      for (const row of rows) {
        if (row.round !== round || row.week !== week) continue;
        // A commissioner-entered row is authoritative; leave it exactly as it is.
        if ((row.manual_fields && row.manual_fields.length) || row.drop_locked) {
          skippedManual.push(row[nameKey]);
          continue;
        }
        const stats = source[row[nameKey]];
        if (!stats) continue;
        let changed = false;
        for (const f of fields) {
          // Only fill a hole. An existing value is never overwritten — this is a repair, not a
          // re-import, and a stored number may reflect a correction we should not undo.
          if (!row[f] && stats[f]) {
            row[f] = stats[f];
            changed = true;
          }
        }
        if (changed) filled[counterKey]++;
      }
    };

    fill(sd.weekly_batting || [], 'batter', batting, BAT_FIELDS, 'batting');
    fill(sd.weekly_pitching || [], 'pitcher', pitching, PIT_FIELDS, 'pitching');

    // The safety assertion. Nothing here should be able to move a total; prove it before writing.
    const after = captureScoreSnapshot(sd, todayET).totals;
    const moved = [];
    for (const mgr of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = (before[mgr] && before[mgr].total) || 0;
      const a = (after[mgr] && after[mgr].total) || 0;
      if (Math.abs(a - b) >= 0.01) moved.push({ manager: mgr, before: b, after: a });
    }
    if (moved.length) {
      return res.status(409).json({
        error: 'Aborted — filling unscored fields changed a manager total, which must never happen.',
        moved,
      });
    }

    addAuditEntry(db, 'backfill_unscored', {
      year,
      round,
      week,
      batting_rows_filled: filled.batting,
      pitching_rows_filled: filled.pitching,
    });
    db.seasons[year] = sd;
    writeDB(db);
    res.json({
      ok: true,
      week: { round, week, start: dates.start, end: dates.end },
      games_fetched: gameRecords.length,
      batting_rows_filled: filled.batting,
      pitching_rows_filled: filled.pitching,
      skipped_manual: [...new Set(skippedManual)],
      manager_totals_unchanged: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Overridable so the MLB integration can be exercised against a stub locally — the dry-run and
// backfill paths are otherwise untestable without live network access. Unset in production, where
// it falls back to the real API.
const MLB_API_BASE = process.env.MLB_API_BASE || 'https://statsapi.mlb.com';

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
      if (game.status?.abstractGameState !== 'Final') continue;
      // Take the date from the GAME, not from the wrapper it arrived in.
      //
      // A postponed game keeps its ORIGINALLY SCHEDULED date in the schedule response — a rainout
      // from May 5 made up on July 7 is still listed under May 5, and once the makeup is played it
      // reads Final. Trusting `dateEntry.date` therefore credits July's stat line to a May week:
      // that is exactly how a July 7 Brewers-Cardinals game (gamePk 823062) turned up as a May 5
      // start, handing a manager points he had not earned that week.
      //
      // `officialDate` is the day the game actually counts for. Games whose official date falls
      // outside the requested range are dropped outright — the range is the caller's contract, and
      // a re-sync of a past week must not absorb a makeup played months later.
      const playedOn = game.officialDate || (game.gameDate ? game.gameDate.slice(0, 10) : dateEntry.date);
      if (playedOn < startDate || playedOn > endDate) continue;
      games.push({ gameId: game.gamePk, date: playedOn });
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
          so: bs.strikeOuts || 0,
          lob: bs.leftOnBase || 0,
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
      if (!batting[name]) {
        batting[name] = { '1b': 0, '2b': 0, '3b': 0, hr: 0, r: 0, rbi: 0, sb: 0, bb: 0, abs: 0, so: 0, lob: 0 };
      }
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
// GET /api/diag/rollup-audit?year=YYYY[&tolerance=N]
// Every manager-week whose certified subtotal disagrees with the same week rebuilt from the daily
// rows inside that manager's own roster windows, each naming the players responsible. This is the
// "why does Slack disagree with the app" question answered directly: on 2026-07-29 it would have
// returned Daniel Kortan QF|Week 2, certified 0 vs 37.35, Gavin Williams — in one call, instead of
// an hour of reading the DB by hand. Read-only.
app.get('/api/diag/rollup-audit', requireCommissioner, (req, res) => {
  const year = (req.query.year || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });
  const tolerance = Number.isFinite(parseFloat(req.query.tolerance)) ? parseFloat(req.query.tolerance) : 0.5;
  const findings = auditWeeklyRollupDrift(sd, { tolerance });
  res.json({ year, tolerance, clean: findings.length === 0, findings });
});

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

// POST /api/seasons/:year/purge-orphan-boundary-rosters[?dryRun=1]
// Clears period-BOUNDARY week-1 rosters (PP2/QF/SF/Finals Week 1) that are NOT backed by a
// submission for that period. A boundary week must be owned by its own submission — never by the
// prior period's carry-forward. repairCarryForwardRosters used to re-fill the boundary week from
// the previous period's Week-5 roster (fixed in ROSTER_REPAIR_VERSION 7 to reset at boundaries),
// which left managers who never submitted showing a full (wrong) carry-forward roster while the
// "lineup not submitted" warning kept firing (the warning keys off the submission, not the
// roster). This removes those orphaned arrays + their roster_dates + zero-stat weekly rows so the
// boundary week is empty until the manager submits. Managers WITH a pending/approved submission
// for the period are left untouched. Any boundary week that already has real (nonzero) points is
// skipped. Score-neutral by construction (an unplayed boundary week scores 0). Pass ?dryRun=1 (or
// { dryRun: true }) to preview without writing. Returns a before/after per-manager total check.
app.post('/api/seasons/:year/purge-orphan-boundary-rosters', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const scheduleDates = sd.schedule_dates || [];
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const periodKeyByRound = { PP2: 'pp2', QF: 'qf', SF: 'sf', Finals: 'finals' };

  const before = captureScoreSnapshot(sd, todayET).totals;

  const cleared = [];
  const kept = [];
  const skipped = [];

  for (let i = 1; i < SEASON_SCHEDULE.length; i++) {
    const { round, week } = SEASON_SCHEDULE[i];
    // Only period (round) boundaries — the weeks owned by a submission, not carry-forward.
    if (round === SEASON_SCHEDULE[i - 1].round) continue;
    const period = periodKeyByRound[round];
    if (!period) continue;
    const weekKey = `${round}|${week}`;
    const weekStart = scheduleDates[i] ? scheduleDates[i].start : null;
    // Only act once the period has started; future weeks are handled by the normal future-purge.
    if (weekStart && weekStart > todayET) continue;

    const subBucket = (sd.period_submissions || {})[period] || {};

    for (const [mgr, weeks] of Object.entries(sd.rosters || {})) {
      const wr = weeks[weekKey];
      const filled = wr ? (wr.batters || []).length + (wr.pitchers || []).length : 0;
      if (filled === 0) continue;

      const sub = subBucket[mgr];
      const hasSub = sub && (sub.status === 'pending' || sub.status === 'approved');
      if (hasSub) {
        kept.push({ manager: mgr, week: weekKey, sub_status: sub.status, players: filled });
        continue;
      }

      // Never disturb a boundary week this manager has actually played (real points).
      const rowMatches = (r) => r.round === round && r.week === week && r.manager === mgr;
      const hasRealStats =
        (sd.weekly_batting || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0) ||
        (sd.weekly_pitching || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0);
      if (hasRealStats) {
        skipped.push({ manager: mgr, week: weekKey, players: filled, reason: 'has_real_points' });
        continue;
      }

      const batters = (wr.batters || []).slice();
      const pitchers = (wr.pitchers || []).slice();
      if (!dryRun) {
        delete weeks[weekKey];
        if (sd.roster_dates && sd.roster_dates[mgr]) delete sd.roster_dates[mgr][weekKey];
        sd.weekly_batting = (sd.weekly_batting || []).filter((r) => !rowMatches(r));
        sd.weekly_pitching = (sd.weekly_pitching || []).filter((r) => !rowMatches(r));
      }
      cleared.push({ manager: mgr, week: weekKey, sub_status: sub ? sub.status : 'none', batters, pitchers });
    }
  }

  const after = dryRun ? before : captureScoreSnapshot(sd, todayET).totals;
  const movedTotals = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[m] || {}).total || 0;
    const a = (after[m] || {}).total || 0;
    if (Math.abs(a - b) >= 0.01) {
      movedTotals.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
    }
  }

  if (!dryRun && cleared.length > 0) {
    db.seasons[year] = sd;
    addAuditEntry(db, 'purge_orphan_boundary_rosters', { year, cleared: cleared.length }, req.get('X-User-Email'));
    writeDB(db);
  }

  res.json({ ok: true, dryRun, cleared, kept, skipped, moved_totals: movedTotals });
});

// POST /api/seasons/:year/reseed-approved-boundary-rosters[?dryRun=1]
// Rewrites a started period-boundary week (PP2/QF/SF/Finals Week 1) from a manager's APPROVED
// submission when the approval's roster side-effect never landed. Approving a period submission
// persists the submission record atomically, but the roster + roster_dates write goes through the
// clobber-prone full-season save — if that save was clobbered, the manager keeps showing the
// PRIOR period's carry-forward roster (wrong players) even though their submission reads approved
// (e.g. PP2 Week 1 still holding PP1 holdovers). This sets the array + roster_dates (add_date =
// period start) from the submission and prunes the stale zero-stat carry-forward rows. To avoid
// clobbering a LEGITIMATE in-period swap, it only acts on managers who have NO period-dated
// roster_dates AND no approved swap effective in the period — i.e. the submission is provably the
// only source of truth for that week. Skips any week with real (nonzero) points. Score-neutral
// while the period is unplayed. Pass ?dryRun=1 (or { dryRun: true }) to preview.
app.post('/api/seasons/:year/reseed-approved-boundary-rosters', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const scheduleDates = sd.schedule_dates || [];
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const periodKeyByRound = { PP2: 'pp2', QF: 'qf', SF: 'sf', Finals: 'finals' };
  const approvedSwaps = (sd.swaps || []).filter((s) => s.status === 'approved');

  const before = captureScoreSnapshot(sd, todayET).totals;

  const reseeded = [];
  const skipped = [];

  for (let i = 1; i < SEASON_SCHEDULE.length; i++) {
    const { round, week } = SEASON_SCHEDULE[i];
    if (round === SEASON_SCHEDULE[i - 1].round) continue; // boundaries only
    const period = periodKeyByRound[round];
    if (!period) continue;
    const weekKey = `${round}|${week}`;
    const weekStart = scheduleDates[i] ? scheduleDates[i].start : null;
    if (weekStart && weekStart > todayET) continue; // only started periods
    const periodStart = periodStartForRound(sd, round);
    if (!periodStart) continue;

    const subBucket = (sd.period_submissions || {})[period] || {};

    for (const [mgr, sub] of Object.entries(subBucket)) {
      if (!sub || sub.status !== 'approved') continue;
      const desiredBat = Array.isArray(sub.batters) ? sub.batters.slice() : [];
      const desiredPit = Array.isArray(sub.pitchers) ? sub.pitchers.slice() : [];
      if (desiredBat.length === 0 && desiredPit.length === 0) continue;

      // Don't clobber a legitimate in-period move: skip if this manager already has any
      // roster_dates event dated within the period, or an approved swap effective in it.
      const mgrDates = (sd.roster_dates || {})[mgr] || {};
      let hasPeriodActivity = false;
      for (const wk of Object.values(mgrDates)) {
        for (const d of Object.values(wk || {})) {
          if ((d.add_date && d.add_date >= periodStart) || (d.drop_date && d.drop_date >= periodStart)) {
            hasPeriodActivity = true;
            break;
          }
        }
        if (hasPeriodActivity) break;
      }
      if (!hasPeriodActivity) {
        hasPeriodActivity = approvedSwaps.some((s) => s.manager === mgr && s.swap_date && s.swap_date >= periodStart);
      }
      if (hasPeriodActivity) {
        skipped.push({ manager: mgr, week: weekKey, reason: 'has_period_roster_activity' });
        continue;
      }

      // Never rewrite a week this manager has actually played.
      const rowMatches = (r) => r.round === round && r.week === week && r.manager === mgr;
      const hasRealStats =
        (sd.weekly_batting || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0) ||
        (sd.weekly_pitching || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0);
      if (hasRealStats) {
        skipped.push({ manager: mgr, week: weekKey, reason: 'has_real_points' });
        continue;
      }

      const mgrRosters = (sd.rosters || {})[mgr] || {};
      const current = mgrRosters[weekKey] || { batters: [], pitchers: [] };
      const curBat = current.batters || [];
      const curPit = current.pitchers || [];
      const removed = [
        ...curBat.filter((p) => !desiredBat.includes(p)),
        ...curPit.filter((p) => !desiredPit.includes(p)),
      ];
      const added = [
        ...desiredBat.filter((p) => !curBat.includes(p)),
        ...desiredPit.filter((p) => !curPit.includes(p)),
      ];
      if (removed.length === 0 && added.length === 0) {
        // Array already matches the submission; just ensure roster_dates are stamped.
        if (!dryRun) {
          if (!sd.roster_dates) sd.roster_dates = {};
          if (!sd.roster_dates[mgr]) sd.roster_dates[mgr] = {};
          const dates = {};
          for (const p of [...desiredBat, ...desiredPit]) dates[p] = { add_date: periodStart };
          sd.roster_dates[mgr][weekKey] = dates;
        }
        skipped.push({ manager: mgr, week: weekKey, reason: 'array_matches_submission_dates_stamped' });
        continue;
      }

      if (!dryRun) {
        if (!sd.rosters) sd.rosters = {};
        if (!sd.rosters[mgr]) sd.rosters[mgr] = {};
        sd.rosters[mgr][weekKey] = { batters: desiredBat.slice(), pitchers: desiredPit.slice() };

        if (!sd.roster_dates) sd.roster_dates = {};
        if (!sd.roster_dates[mgr]) sd.roster_dates[mgr] = {};
        const dates = {};
        for (const p of [...desiredBat, ...desiredPit]) dates[p] = { add_date: periodStart };
        sd.roster_dates[mgr][weekKey] = dates;

        // Prune stale zero-stat weekly rows for players no longer on the week's roster.
        sd.weekly_batting = (sd.weekly_batting || []).filter((r) => !(rowMatches(r) && !desiredBat.includes(r.batter)));
        sd.weekly_pitching = (sd.weekly_pitching || []).filter(
          (r) => !(rowMatches(r) && !desiredPit.includes(r.pitcher))
        );
      }
      reseeded.push({ manager: mgr, week: weekKey, removed, added });
    }
  }

  const reseedAfter = dryRun ? before : captureScoreSnapshot(sd, todayET).totals;
  const reseedMoved = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(reseedAfter)])) {
    const b = (before[m] || {}).total || 0;
    const a = (reseedAfter[m] || {}).total || 0;
    if (Math.abs(a - b) >= 0.01) {
      reseedMoved.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
    }
  }

  if (!dryRun && (reseeded.length > 0 || skipped.some((s) => s.reason === 'array_matches_submission_dates_stamped'))) {
    db.seasons[year] = sd;
    addAuditEntry(db, 'reseed_approved_boundary_rosters', { year, reseeded: reseeded.length }, req.get('X-User-Email'));
    writeDB(db);
  }

  res.json({ ok: true, dryRun, reseeded, skipped, moved_totals: reseedMoved });
});

// POST /api/seasons/:year/reconcile-boundary-rosters[?dryRun=1]
// Prunes ARRAY-ONLY orphan players from started period-BOUNDARY weeks (PP2/QF/SF/Finals Week 1).
// A boundary week's roster array must exactly equal that week's roster_dates (the period starts
// fresh from its submission, which writes both). A stale pre-boundary-fix client can re-add a prior
// period's holdover to the array via carry-forward (a non-empty client array wins the full-season
// save), leaving a player in the array with NO roster_dates entry for the week — an orphan that
// shows as an extra roster slot and scores via the array. This removes any array player not present
// in that week's roster_dates (+ their zero-stat weekly rows). Only touches managers who already
// have a roster_dates roster for the week (a real, submission-backed roster — pure no-submission
// orphans are the purge endpoint's job). Skips weeks with real points. Score-neutral (orphans have
// 0 points while the period is unplayed). Boundary weeks ONLY — mid-period weeks legitimately hold
// carried-forward players whose roster_dates live under an earlier week, so they are never touched.
// Re-runnable; pass ?dryRun=1 (or { dryRun: true }) to preview.
app.post('/api/seasons/:year/reconcile-boundary-rosters', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const scheduleDates = sd.schedule_dates || [];
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const before = captureScoreSnapshot(sd, todayET).totals;

  const reconciled = [];
  const skipped = [];

  for (let i = 1; i < SEASON_SCHEDULE.length; i++) {
    const { round, week } = SEASON_SCHEDULE[i];
    if (round === SEASON_SCHEDULE[i - 1].round) continue; // boundaries only
    const weekKey = `${round}|${week}`;
    const weekStart = scheduleDates[i] ? scheduleDates[i].start : null;
    if (weekStart && weekStart > todayET) continue; // only started periods

    for (const [mgr, weeks] of Object.entries(sd.rosters || {})) {
      const wr = weeks[weekKey];
      if (!wr) continue;
      const rdWeek = ((sd.roster_dates || {})[mgr] || {})[weekKey] || {};
      const backed = new Set(Object.keys(rdWeek));
      // Only act on a manager who has a real (roster_dates-backed) roster for this week; pure
      // no-submission orphans (empty roster_dates) are cleared wholesale by the purge endpoint.
      if (backed.size === 0) continue;

      const orphanBat = (wr.batters || []).filter((p) => !backed.has(p));
      const orphanPit = (wr.pitchers || []).filter((p) => !backed.has(p));
      if (orphanBat.length === 0 && orphanPit.length === 0) continue;

      // Never disturb a week that has actually been played.
      const rowMatches = (r) => r.round === round && r.week === week && r.manager === mgr;
      const hasRealStats =
        (sd.weekly_batting || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0) ||
        (sd.weekly_pitching || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0);
      if (hasRealStats) {
        skipped.push({ manager: mgr, week: weekKey, reason: 'has_real_points', orphans: [...orphanBat, ...orphanPit] });
        continue;
      }

      if (!dryRun) {
        wr.batters = (wr.batters || []).filter((p) => backed.has(p));
        wr.pitchers = (wr.pitchers || []).filter((p) => backed.has(p));
        const orphans = new Set([...orphanBat, ...orphanPit]);
        sd.weekly_batting = (sd.weekly_batting || []).filter((r) => !(rowMatches(r) && orphans.has(r.batter)));
        sd.weekly_pitching = (sd.weekly_pitching || []).filter((r) => !(rowMatches(r) && orphans.has(r.pitcher)));
      }
      reconciled.push({ manager: mgr, week: weekKey, removed: [...orphanBat, ...orphanPit] });
    }
  }

  const after = dryRun ? before : captureScoreSnapshot(sd, todayET).totals;
  const movedTotals = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[m] || {}).total || 0;
    const a = (after[m] || {}).total || 0;
    if (Math.abs(a - b) >= 0.01) {
      movedTotals.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
    }
  }

  if (!dryRun && reconciled.length > 0) {
    db.seasons[year] = sd;
    addAuditEntry(db, 'reconcile_boundary_rosters', { year, reconciled: reconciled.length }, req.get('X-User-Email'));
    writeDB(db);
  }

  res.json({ ok: true, dryRun, reconciled, skipped, moved_totals: movedTotals });
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

  for (const bucket of Object.values(sd.period_submissions || {})) {
    for (const sub of Object.values(bucket || {})) {
      (sub.batters || []).forEach(add);
      (sub.pitchers || []).forEach(add);
    }
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

  for (const bucket of Object.values(sd.period_submissions || {})) {
    for (const sub of Object.values(bucket || {})) {
      renameArr(sub.batters);
      renameArr(sub.pitchers);
    }
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

// Every player name a season's records actually depend on: rosters, submissions
// (initial + period), swaps, roster_dates, and manager-attributed stat rows.
// Pool/team-map/mlb_ids keys are deliberately excluded — this set answers "would
// touching this name affect anyone's roster or score?", which gates the duplicate
// cleanup in bootstrapPlayerPools. Unattributed stat rows are also excluded: the
// sync stores a row for every player in every boxscore, so a bare duplicate name
// ("Max Muncy") always has orphan rows that say nothing about WMMC rosters.
function referencedPlayerNames(sd) {
  const names = new Set();
  const add = (v) => {
    if (v && typeof v === 'string') names.add(v);
  };
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
  for (const bucket of Object.values(sd.period_submissions || {})) {
    for (const sub of Object.values(bucket || {})) {
      (sub.batters || []).forEach(add);
      (sub.pitchers || []).forEach(add);
    }
  }
  for (const s of sd.swaps || []) {
    add(s.player_in);
    add(s.player_out);
  }
  for (const mgrDates of Object.values(sd.roster_dates || {})) {
    for (const weekDates of Object.values(mgrDates)) Object.keys(weekDates).forEach(add);
  }
  (sd.weekly_batting || []).forEach((r) => r.manager && add(r.batter));
  (sd.weekly_pitching || []).forEach((r) => r.manager && add(r.pitcher));
  (sd.daily_batting || []).forEach((r) => r.manager && add(r.batter));
  (sd.daily_pitching || []).forEach((r) => r.manager && add(r.pitcher));
  return names;
}

// Seed sd.batters_pool / sd.pitchers_pool from MLB's active-player catalog so
// every name that could earn fantasy points is searchable in the My Roster
// autocomplete, including players who haven't appeared in a boxscore yet
// (injured, just promoted, on bench). Two-way players (Ohtani-style) land in
// both pools. Team maps are refreshed every call so mid-season trades stay
// current. Names already in a pool are preserved through refreshes so any
// commissioner-curated additions survive; the one exception is a bare name the
// catalog shows to be two different players (see duplicate handling below).
//
// Duplicate fullNames (MLB has two "Max Muncy"s) get team-disambiguated pool
// keys — "Max Muncy (LAD)" / "Max Muncy (ATH)" — each claimed by MLB id in
// sd.mlb_ids so boxscore stats route to the right entry. A bare duplicate key
// would collapse both players into one entry whose team flip-flops with catalog
// order, leaving the other player unselectable in the swap form.
async function bootstrapPlayerPools(sd, season, { refresh = false } = {}) {
  const catalog = await fetchMLBPlayerCatalog(season, { refresh });

  if (!sd.batters_pool) sd.batters_pool = [];
  if (!sd.pitchers_pool) sd.pitchers_pool = [];
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};
  if (!sd.mlb_ids) sd.mlb_ids = {};

  let changed = false;

  // A season can accumulate duplicate pool entries (e.g. a name-fix rename landing on a
  // name this bootstrap already added). Dedupe in place, preserving first-seen order.
  if (new Set(sd.batters_pool).size !== sd.batters_pool.length) {
    sd.batters_pool = [...new Set(sd.batters_pool)];
    changed = true;
  }
  if (new Set(sd.pitchers_pool).size !== sd.pitchers_pool.length) {
    sd.pitchers_pool = [...new Set(sd.pitchers_pool)];
    changed = true;
  }

  const nameCounts = new Map();
  for (const p of catalog) {
    if (p.fullName) nameCounts.set(p.fullName, (nameCounts.get(p.fullName) || 0) + 1);
  }

  const referenced = referencedPlayerNames(sd);
  const battersSet = new Set(sd.batters_pool);
  const pitchersSet = new Set(sd.pitchers_pool);
  const idsInUse = new Set(Object.values(sd.mlb_ids).filter((v) => typeof v === 'number'));
  let battersAdded = 0;
  let pitchersAdded = 0;

  for (const p of catalog) {
    const base = p.fullName;
    if (!base) continue;
    const dup = (nameCounts.get(base) || 0) > 1;
    const name = dup ? `${base} (${p.team || p.id})` : base;
    const pos = p.position || '';
    const isPitcher = pos === 'P' || pos === 'SP' || pos === 'RP' || pos === 'TWP';
    const isBatter = pos !== 'P' && pos !== 'SP' && pos !== 'RP'; // TWP also bats

    if (isBatter) {
      if (!battersSet.has(name)) {
        sd.batters_pool.push(name);
        battersSet.add(name);
        battersAdded++;
      }
      if (p.team && sd.batters_team[name] !== p.team) {
        sd.batters_team[name] = p.team;
        changed = true;
      }
    }
    if (isPitcher) {
      if (!pitchersSet.has(name)) {
        sd.pitchers_pool.push(name);
        pitchersSet.add(name);
        pitchersAdded++;
      }
      if (p.team && sd.pitchers_team[name] !== p.team) {
        sd.pitchers_team[name] = p.team;
        changed = true;
      }
    }
    // A disambiguated entry is only routable to the right MLB player by id, so claim
    // it now — unless that id is already claimed, or the bare name is referenced by a
    // roster/swap without an id claim of its own (then which player the records mean
    // is genuinely ambiguous and the commissioner must resolve it via roster-fix —
    // auto-claiming here would silently redirect a rostered player's future stats).
    if (
      dup &&
      !(name in sd.mlb_ids) &&
      !idsInUse.has(p.id) &&
      !(referenced.has(base) && typeof sd.mlb_ids[base] !== 'number')
    ) {
      sd.mlb_ids[name] = p.id;
      idsInUse.add(p.id);
      changed = true;
    }
  }

  // Retire bare duplicate-name entries that earlier bootstraps collapsed (one
  // "Max Muncy" hiding two players) — but only when nothing in the season
  // references the bare name and it carries no id claim, so no roster, swap,
  // or score record is ever rewritten.
  for (const [base, count] of nameCounts) {
    if (count < 2) continue;
    if (referenced.has(base) || typeof sd.mlb_ids[base] === 'number') continue;
    if (battersSet.has(base)) {
      sd.batters_pool = sd.batters_pool.filter((n) => n !== base);
      battersSet.delete(base);
      delete sd.batters_team[base];
      changed = true;
    }
    if (pitchersSet.has(base)) {
      sd.pitchers_pool = sd.pitchers_pool.filter((n) => n !== base);
      pitchersSet.delete(base);
      delete sd.pitchers_team[base];
      changed = true;
    }
  }

  // Names claimed via sd.mlb_ids (roster-fix renames like "Nicholas Kurtz", or the
  // disambiguated duplicates above) otherwise only get a team label when they appear
  // in a synced boxscore — an injured or just-added player showed no team on the
  // scoreboard. Stamp their team from the catalog so the label is always current.
  const byId = new Map(catalog.map((p) => [p.id, p]));
  for (const [name, id] of Object.entries(sd.mlb_ids)) {
    const entry = typeof id === 'number' ? byId.get(id) : undefined;
    if (!entry || !entry.team) continue;
    const pos = entry.position || '';
    const isPitcher = pos === 'P' || pos === 'SP' || pos === 'RP' || pos === 'TWP';
    const isBatter = pos !== 'P' && pos !== 'SP' && pos !== 'RP';
    if (isBatter && sd.batters_team[name] !== entry.team) {
      sd.batters_team[name] = entry.team;
      changed = true;
    }
    if (isPitcher && sd.pitchers_team[name] !== entry.team) {
      sd.pitchers_team[name] = entry.team;
      changed = true;
    }
  }

  return { battersAdded, pitchersAdded, changed, catalogSize: catalog.length };
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
//   unrostered_auto    — not rostered but still in a pool, fuzzy score >= 0.75
//   unrostered_replace — not rostered but still in a pool, fuzzy score < 0.75
//
// Unrostered buckets require current pool membership: a mismatched name that is
// no longer in either pool was already retired by a fix (its history records are
// kept by design) and must not be re-reported — that made Scan → Apply loop.
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
    const catalogNames = new Set(catalog.map((p) => p.fullName));
    const allWmmcNames = extractSeasonPlayerNames(sd);
    const rostered = getRosteredNames(sd);
    const mlbIds = sd.mlb_ids || {};
    const inPool = new Set([...(sd.batters_pool || []), ...(sd.pitchers_pool || [])]);

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

      // Unrostered catalog-exact names are ordinary bootstrap pool entries — not a
      // problem to report (and roster-fix no longer purges them).
      if (catalogNames.has(wmmcName)) continue;

      // Not in any pool: a previous fix already retired it (history-referenced
      // phantoms like the corrective-swap leftover "Nicholas Kurtz" keep their
      // records forever by design), or the name only ever existed in history
      // records. Either way nothing actionable remains — re-reporting it made
      // Scan → Apply loop endlessly with "nothing changes".
      if (!inPool.has(wmmcName)) continue;

      // Unrostered with a name mismatch: roster-fix will retire or purge these.
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

  for (const bucket of Object.values(sd.period_submissions || {})) {
    for (const sub of Object.values(bucket || {})) {
      removeFromArr(sub.batters);
      removeFromArr(sub.pitchers);
    }
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
//   4. Mismatched unrostered names (no exact catalog fullName, no valid mlb_id claim,
//      not the target of a rename from this same pass) are cleaned up two ways:
//      - RETIRED from the pools (history kept) when rosters/submissions/swaps/
//        roster_dates/attributed stats still reference the name — e.g. the phantom
//        "Nicholas Kurtz" left behind after a corrective swap to "Nick Kurtz". The
//        referencing records are origin records (a swap legitimizes its replacement
//        player), so a full purge would corrupt history; pulling the name from the
//        pools is enough to stop it being swapped in again.
//      - PURGED entirely when nothing references them (orphan typo'd entries).
//      Catalog-exact names are ordinary pool entries (the pool is seeded from the MLB
//      catalog) and id-claimed names are identified duplicate keys ("Max Muncy (LAD)")
//      — neither is touched.
//
// The response includes a before/after per-manager totals comparison (totals_moved).
// Renames CAN move totals upward by design: a misspelled rostered name's stat rows sat
// unattributed under the MLB spelling, and the rename merges them into the roster window.
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

    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const totalsBefore = captureScoreSnapshot(sd, todayET).totals;

    if (!sd.mlb_ids) sd.mlb_ids = {};
    const idsInUse = new Map(Object.entries(sd.mlb_ids).map(([n, id]) => [id, n]));

    const applied = [];
    const idsAssigned = [];
    const needsManual = [];
    const purged = [];
    const purgeCandidates = [];
    // Names created by a manual rename this pass. The `rostered` set above is a
    // pre-pass snapshot, so a rename target would otherwise read as unrostered and
    // be purged right after being written — protect it explicitly.
    const renameTargets = new Set();

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
        if (to !== wmmcName) {
          occurrences = renamePlayerInSeason(sd, wmmcName, to);
          renameTargets.add(to);
        }
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

      // Unrostered: defer to the guarded purge pass below, which needs the final
      // state of renames and id claims from this loop.
      purgeCandidates.push(wmmcName);
    }

    // Clean up genuinely mismatched unrostered names (see rule 4 above). References
    // are recomputed AFTER the rename loop so they reflect this pass's final state.
    const catalogNames = new Set(catalog.map((p) => p.fullName));
    const referenced = referencedPlayerNames(sd);
    const retiredFromPool = [];
    for (const name of purgeCandidates) {
      if (renameTargets.has(name)) continue;
      if (catalogNames.has(name)) continue;
      // Mirror the audit: a name absent from both pools was already retired (or
      // never was a pool entry) — terminal state, nothing to retire or purge.
      if (!(sd.batters_pool || []).includes(name) && !(sd.pitchers_pool || []).includes(name)) continue;
      const claimedId = sd.mlb_ids[name];
      if (typeof claimedId === 'number' && byId.has(claimedId)) continue;
      if (referenced.has(name)) {
        // History references this name — retire it from the pools, keep every record.
        const pools = [];
        if ((sd.batters_pool || []).includes(name)) {
          sd.batters_pool = sd.batters_pool.filter((n) => n !== name);
          if (sd.batters_team) delete sd.batters_team[name];
          pools.push('batters');
        }
        if ((sd.pitchers_pool || []).includes(name)) {
          sd.pitchers_pool = sd.pitchers_pool.filter((n) => n !== name);
          if (sd.pitchers_team) delete sd.pitchers_team[name];
          pools.push('pitchers');
        }
        if (pools.length > 0) retiredFromPool.push({ name, pools });
        continue;
      }
      const removed = purgePlayerFromSeason(sd, name);
      purged.push({ name, records_removed: removed });
    }

    const totalsAfter = captureScoreSnapshot(sd, todayET).totals;
    const totalsMoved = [];
    for (const m of new Set([...Object.keys(totalsBefore), ...Object.keys(totalsAfter)])) {
      const b = (totalsBefore[m] || {}).total || 0;
      const a = (totalsAfter[m] || {}).total || 0;
      if (Math.abs(a - b) >= 0.01) {
        totalsMoved.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
      }
    }

    if (applied.length > 0 || idsAssigned.length > 0 || purged.length > 0 || retiredFromPool.length > 0) {
      db.seasons[year] = sd;
      addAuditEntry(db, 'roster_name_fix', {
        year,
        renames: applied.length,
        ids_assigned: idsAssigned.length,
        purged: purged.length,
        retired_from_pool: retiredFromPool.length,
        detail: { applied, ids_assigned: idsAssigned, purged, retired_from_pool: retiredFromPool },
      });
      writeDB(db);
    }

    res.json({
      ok: true,
      summary: {
        renames_applied: applied.length,
        ids_assigned: idsAssigned.length,
        players_retired: retiredFromPool.length,
        players_purged: purged.length,
        needs_manual_review: needsManual.length,
      },
      applied,
      ids_assigned: idsAssigned,
      retired_from_pool: retiredFromPool,
      purged,
      totals_moved: totalsMoved,
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

// ============================================================
// Live day (the game day the Live views should be showing)
// ============================================================
// The "live day" is NOT the ET calendar date. MLB games routinely start before midnight ET and
// finish after it, so a hard midnight cutoff blanks a still-running slate: at 12:00am the Live
// tab jumped to the new (empty) date, every manager's daily total reset to 0.00, and games still
// in the 7th disappeared from Today's Games.
//
// Instead a game day is owned by the date it STARTS on — which is already how MLB's own schedule
// groups games (a 10:05pm ET first pitch keeps that day's date all the way to the final out). That
// day stays live through the following morning until the new day's slate is about to begin:
//
//     rollover = min(earliest first pitch of the new calendar day - 2h, 12:00pm ET)
//
// Before the rollover the previous date is still the live day; at or after it, the new calendar
// date takes over. Two guards keep the hold-over honest: a previous date with no games at all
// never holds the view (there is nothing to show), and an unreachable MLB API falls back to the
// plain calendar date rather than freezing on a day we cannot confirm.
//
// This governs DISPLAY/READ surfaces only (the Live tab and its per-game boxscores). Paths that
// STAMP dates into the database — swap add_date/drop_date, the sync snapshot date, the roster
// backfills — deliberately keep using the true ET calendar date: roster date windows are the
// scoring invariant's source of truth, and back-dating a write into an already-scored day would
// rewrite a certified total.
const LIVE_DAY_LEAD_MS = 2 * 60 * 60 * 1000; // show the new day starting 2h before its first pitch
const LIVE_DAY_MAX_HOUR = 12; // ...and never hold the previous day past noon ET
const LIVE_DAY_CACHE_MS = 60 * 1000; // the Live tab polls every 2m; don't re-hit MLB for each caller

let _liveDayCache = null; // { until: epochMs, value: {...} }

// Minutes past midnight in Eastern time. hourCycle 'h23' so midnight is 0, not 24.
function etMinutesOfDay(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return hour * 60 + minute;
}

// Epoch ms for `hour`:00 Eastern on an ISO date. Mirrors getNextEasternHour's DST handling:
// sample the UTC offset at noon UTC, which never lands on a 2am Eastern transition.
function etEpochForHour(isoDate, hour) {
  const [yr, mo, dy] = isoDate.split('-').map(Number);
  const noonUTC = new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0));
  const noonEasternHour = +new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(noonUTC);
  const offsetHours = noonEasternHour - 12; // -4 (EDT) or -5 (EST)
  return Date.UTC(yr, mo - 1, dy, hour - offsetHours, 0, 0);
}

// Resolve the current live day. See the block comment above for the rule. Never throws —
// on any MLB API failure it degrades to the ET calendar date.
async function resolveLiveDay(now = new Date()) {
  if (_liveDayCache && now.getTime() < _liveDayCache.until) return _liveDayCache.value;

  const calendarDay = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const rolledOver = (reason) => ({
    live_day: calendarDay,
    calendar_day: calendarDay,
    live_day_is_previous: false,
    rollover_at: null,
    reason,
  });

  const cache = (value, until) => {
    _liveDayCache = { until, value };
    return value;
  };

  const minutesNow = etMinutesOfDay(now);
  const noonEpoch = etEpochForHour(calendarDay, LIVE_DAY_MAX_HOUR);
  // Past the latest possible rollover — no schedule lookup needed.
  if (minutesNow >= LIVE_DAY_MAX_HOUR * 60) {
    return cache(rolledOver('past_noon_et'), now.getTime() + LIVE_DAY_CACHE_MS);
  }

  const previousDay = isoDateAddDays(calendarDay, -1);
  let scheduleData;
  try {
    scheduleData = await mlbApiFetch(
      `/api/v1/schedule?sportId=1&startDate=${previousDay}&endDate=${calendarDay}&gameType=R,F,D,L,W`
    );
  } catch (e) {
    console.error('[LiveDay] schedule lookup failed, falling back to the calendar date:', e.message);
    // Short cache so a transient blip doesn't pin the fallback for long.
    return cache(rolledOver('schedule_unavailable'), now.getTime() + 15_000);
  }

  const gamesByDate = {};
  for (const entry of scheduleData.dates || []) gamesByDate[entry.date] = entry.games || [];

  // Nothing played yesterday — there is no slate to hold over.
  if (!(gamesByDate[previousDay] || []).length) {
    return cache(rolledOver('no_games_previous_day'), now.getTime() + LIVE_DAY_CACHE_MS);
  }

  // Earliest scheduled first pitch on the new calendar day (gameDate is the UTC first-pitch stamp).
  let earliestStart = null;
  for (const g of gamesByDate[calendarDay] || []) {
    const t = g.gameDate ? Date.parse(g.gameDate) : NaN;
    if (Number.isFinite(t) && (earliestStart === null || t < earliestStart)) earliestStart = t;
  }

  // No games today → hold yesterday until the noon cap.
  const rolloverEpoch = earliestStart === null ? noonEpoch : Math.min(earliestStart - LIVE_DAY_LEAD_MS, noonEpoch);

  if (now.getTime() >= rolloverEpoch) {
    return cache(rolledOver('after_rollover'), now.getTime() + LIVE_DAY_CACHE_MS);
  }

  const value = {
    live_day: previousDay,
    calendar_day: calendarDay,
    live_day_is_previous: true,
    rollover_at: new Date(rolloverEpoch).toISOString(),
    reason: earliestStart === null ? 'no_games_today' : 'before_first_pitch_lead',
  };
  // Never cache across the rollover instant, or the view would sit on a stale day.
  return cache(value, Math.min(now.getTime() + LIVE_DAY_CACHE_MS, rolloverEpoch));
}

// Which teams have a game today (ET) that has already started (Live/Final, or first-pitch time
// already passed)? Returns a Set of team abbreviations. Shared by GET /api/mlb/teams-started and
// the swap auto-apply path (computeSwapEffectiveDatesServer). Throws on MLB API failure — each
// caller picks its own fallback.
//
// Intentionally uses the ET CALENDAR date, not the live day: its callers stamp roster windows,
// and back-dating a swap into an already-played day would rewrite a certified total.
async function fetchStartedTeamsToday() {
  // MLB games are dated in Eastern time; use ET so a late-evening UTC rollover
  // doesn't shift "today" to tomorrow.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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
  return startedSet;
}

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

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  try {
    const startedSet = await fetchStartedTeamsToday();

    // When teams are requested, only report on those; otherwise return all started teams.
    const started = requested.length ? requested.filter((t) => startedSet.has(t)) : Array.from(startedSet);

    res.json({ today, started, any_started: started.length > 0 });
  } catch (e) {
    // On MLB API failure, report nothing as started — the frontend then treats the
    // swap as effective today, the same as the no-games-started path. Keeps swaps usable.
    res.json({ today, started: [], any_started: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Live-tab MLB fetch cache
//
// /api/mlb/live is unauthenticated and polled by every manager who has the tab open
// (every 2 minutes — LIVE_POLL_MS in app.js). Rebuilding it from scratch costs one
// schedule fetch plus one boxscore fetch per Live-or-Final game in the WHOLE schedule
// week, which by Sunday is ~100 sequential round-trips to statsapi.mlb.com — including
// re-fetching Monday's Final boxscores, which can never change. Nothing was shared
// between callers, so each manager paid that cost alone and opening the tab felt like
// it was forcing the sync rather than reading one the server already had.
//
// Four layers fix it, and every one of them caches ONLY MLB-derived data:
//   1. Parsed boxscores keyed by gamePk. A Final game's boxscore is immutable, so it is
//      kept for the life of the process; an in-progress game gets a short TTL, and a
//      game cached mid-flight is always re-fetched once it goes Final (that is when
//      CG/CGSO/NH become creditable — see parseBoxscore's gameIsFinal).
//   2. The week's schedule, so concurrent callers share one lookup.
//   3. A per-week snapshot of 1+2 with single-flight dedupe and stale-while-revalidate:
//      N managers cause one upstream refresh, not N, and a caller with a usable snapshot
//      is answered from memory instead of waiting on MLB.
//   4. A demand-driven warmer that keeps the snapshot fresh while games are live and
//      somebody is actually watching, then stops on its own. Without it a lone manager
//      polling every 2 minutes would always be served a 2-minute-old snapshot.
//
// What is deliberately NOT cached: everything downstream of readDB(). The manager list,
// the date-windowed rosters, and the certified totals are recomputed on every request
// exactly as before. The core scoring invariant requires each view to read managers and
// roster windows completely, every time — a swap approved seconds ago has to show up on
// the next poll, not whenever a snapshot happens to expire.
// ---------------------------------------------------------------------------
// In-progress games only (Final ones never expire). MUST stay below LIVE_SNAPSHOT_TTL_MS:
// if a cached mid-game parse outlived the snapshot that holds it, every snapshot rebuild
// would re-serve the same stale line and live scores would lag a whole extra TTL behind.
const LIVE_BOXSCORE_TTL_MS = 15 * 1000;
const LIVE_SCHEDULE_TTL_MS = 30 * 1000;
const LIVE_SNAPSHOT_TTL_MS = 30 * 1000; // serve straight from memory below this age
const LIVE_SNAPSHOT_MAX_STALE_MS = 5 * 60 * 1000; // above this, block on a fresh build
const LIVE_BOXSCORE_CACHE_MAX = 400; // ~2 schedule weeks of games
const LIVE_BOXSCORE_CONCURRENCY = 5; // only ever reached on a cold snapshot build
const LIVE_WARM_WINDOW_MS = 10 * 60 * 1000; // keep warming this long after the last request
const LIVE_WARM_INTERVAL_MS = 30 * 1000;

// Fingerprint of the MLB-id → WMMC-name mapping. Parsed boxscores are keyed by WMMC
// display name, so a commissioner claiming/re-pointing an id changes what a cached parse
// means. Stamping every cache entry with this makes such a change invalidate the cache
// instead of silently serving stats attributed to the old name.
function mlbIdMapFingerprint(sd) {
  const ids = (sd && sd.mlb_ids) || {};
  let hash = 2166136261; // FNV-1a
  let count = 0;
  for (const [name, id] of Object.entries(ids)) {
    count++;
    const s = `${name}:${id}`;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${count}:${(hash >>> 0).toString(36)}`;
}

// Drop the least-recently-used entries until `map` is back within `max`.
function pruneByLastUsed(map, max) {
  if (map.size <= max) return;
  const byAge = [...map.entries()].sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
  for (const [key] of byAge.slice(0, map.size - max)) map.delete(key);
}

// Track an in-flight promise per key so concurrent callers share one upstream request.
// The stored promise is cleared when it settles; callers get the original promise (with
// its rejection intact) while the bookkeeping chain swallows its own copy of the error.
function singleFlight(inflightMap, key, start) {
  const existing = inflightMap.get(key);
  if (existing) return existing;
  const p = start();
  inflightMap.set(key, p);
  p.catch(() => {}).finally(() => {
    if (inflightMap.get(key) === p) inflightMap.delete(key);
  });
  return p;
}

const _boxscoreCache = new Map(); // gamePk -> { fp, final, fetchedAt, lastUsed, batting, pitching }
const _boxscoreInflight = new Map();

// Parsed boxscore for one game, from cache when it is still trustworthy.
// gameIsFinal comes from the schedule, not the boxscore (which carries no game state).
async function getParsedBoxscore(gamePk, gameIsFinal, idToWmmcName, fp) {
  const key = String(gamePk);
  const now = Date.now();
  const hit = _boxscoreCache.get(key);
  // A cache entry is usable when it was parsed under the same id map AND its game state
  // still matches: a Final parse stays valid forever, an in-progress parse only until the
  // TTL runs out — and never once the game has since gone Final.
  const usable =
    hit && hit.fp === fp && (hit.final ? gameIsFinal : !gameIsFinal && now - hit.fetchedAt < LIVE_BOXSCORE_TTL_MS);
  if (usable) {
    hit.lastUsed = now;
    return hit;
  }

  return singleFlight(_boxscoreInflight, `${key}|${gameIsFinal ? 'F' : 'L'}|${fp}`, async () => {
    const box = await mlbApiFetch(`/api/v1/game/${gamePk}/boxscore`);
    const { batting, pitching } = parseBoxscore(box, idToWmmcName, gameIsFinal);
    const entry = { fp, final: !!gameIsFinal, fetchedAt: Date.now(), lastUsed: Date.now(), batting, pitching };
    _boxscoreCache.set(key, entry);
    pruneByLastUsed(_boxscoreCache, LIVE_BOXSCORE_CACHE_MAX);
    return entry;
  });
}

const _weekScheduleCache = new Map(); // "start|end" -> { fetchedAt, lastUsed, data }
const _weekScheduleInflight = new Map();

// The week's MLB schedule, hydrated with team info (the bare endpoint omits abbreviations,
// which leaves the UI rendering "?" for every matchup).
async function fetchWeekSchedule(start, end) {
  const key = `${start}|${end}`;
  const now = Date.now();
  const hit = _weekScheduleCache.get(key);
  if (hit && now - hit.fetchedAt < LIVE_SCHEDULE_TTL_MS) {
    hit.lastUsed = now;
    return hit.data;
  }
  return singleFlight(_weekScheduleInflight, key, async () => {
    const data = await mlbApiFetch(
      `/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&gameType=R,F,D,L,W&hydrate=team`
    );
    _weekScheduleCache.set(key, { fetchedAt: Date.now(), lastUsed: Date.now(), data });
    pruneByLastUsed(_weekScheduleCache, 3);
    return data;
  });
}

// Normalize the raw schedule payload into the `games` array the Live tab renders.
function gamesFromSchedule(scheduleData) {
  const games = [];
  for (const dateEntry of scheduleData.dates || []) {
    for (const g of dateEntry.games || []) {
      games.push({
        game_id: g.gamePk,
        // Same trap as fetchMLBGames: a postponed game is listed under the date it was originally
        // scheduled for, so the game's own officialDate is what it actually counts for.
        date: g.officialDate || (g.gameDate ? g.gameDate.slice(0, 10) : dateEntry.date),
        scheduled_time: g.gameDate || null,
        state: g.status?.abstractGameState || 'Preview',
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
  return games;
}

const _liveSnapshots = new Map(); // "year|start|end" -> { fp, fetchedAt, games, gameStats }
const _liveSnapshotInflight = new Map();

// Fetch the week's schedule + every Live/Final boxscore in it. Boxscores run a few at a
// time rather than one-by-one: with the per-game cache in front, the only build that hits
// more than a handful of games is the first one after a restart.
async function buildLiveWeekSnapshot(start, end, idToWmmcName, fp) {
  const games = gamesFromSchedule(await fetchWeekSchedule(start, end));
  const needed = games.filter((g) => g.state === 'Live' || g.state === 'Final');

  const gameStats = [];
  let next = 0;
  const worker = async () => {
    while (next < needed.length) {
      const game = needed[next++];
      try {
        const parsed = await getParsedBoxscore(game.game_id, game.state === 'Final', idToWmmcName, fp);
        gameStats.push({
          game_id: game.game_id,
          date: game.date,
          state: game.state,
          batting: parsed.batting,
          pitching: parsed.pitching,
        });
      } catch {
        // One unreadable boxscore must not sink the whole board — skip it, as before.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIVE_BOXSCORE_CONCURRENCY, needed.length) }, worker));

  // Restore schedule order — the workers finish out of order, and a snapshot is reused by
  // many requests, so the per-player game lists must not shuffle between polls.
  gameStats.sort((a, b) => a.date.localeCompare(b.date) || a.game_id - b.game_id);

  return { fp, fetchedAt: Date.now(), games, gameStats };
}

// The week snapshot, with stale-while-revalidate. Returns as soon as there is anything
// usable to return; only a missing or badly stale snapshot makes the caller wait.
async function getLiveWeekSnapshot(year, start, end, idToWmmcName, fp) {
  const key = `${year}|${start}|${end}`;
  const hit = _liveSnapshots.get(key);
  const age = hit && hit.fp === fp ? Date.now() - hit.fetchedAt : Infinity;
  if (hit) hit.lastUsed = Date.now();
  if (age < LIVE_SNAPSHOT_TTL_MS) return hit;

  const refresh = () =>
    singleFlight(_liveSnapshotInflight, key, async () => {
      const snap = await buildLiveWeekSnapshot(start, end, idToWmmcName, fp);
      _liveSnapshots.set(key, { ...snap, lastUsed: Date.now() });
      pruneByLastUsed(_liveSnapshots, 3);
      return snap;
    });

  if (age < LIVE_SNAPSHOT_MAX_STALE_MS) {
    // Good enough to serve right now; get the next poll a fresher one.
    refresh().catch((e) => console.error('[Live] background snapshot refresh failed:', e.message));
    return hit;
  }
  return refresh();
}

// Demand-driven warmer. Every /api/mlb/live request extends the window; while that window
// is open and the last snapshot had a live game, refresh on a timer so the next caller is
// answered from a snapshot that is seconds old rather than a poll-interval old. Re-reads
// the database each tick so it never pins a stale roster or a stale id map.
let _liveWarmUntil = 0;
let _liveWarmTimer = null;
let _liveWarmYear = null;

function noteLiveInterest(year) {
  _liveWarmYear = year;
  _liveWarmUntil = Date.now() + LIVE_WARM_WINDOW_MS;
  if (!_liveWarmTimer) {
    _liveWarmTimer = setTimeout(liveWarmTick, LIVE_WARM_INTERVAL_MS);
    if (_liveWarmTimer.unref) _liveWarmTimer.unref();
  }
}

async function liveWarmTick() {
  _liveWarmTimer = null;
  if (Date.now() >= _liveWarmUntil) return; // nobody watching — stand down
  try {
    const sd = (readDB().seasons || {})[_liveWarmYear];
    const scheduleDates = (sd && sd.schedule_dates) || [];
    const today = (await resolveLiveDay()).live_day;
    const week = scheduleDates.find((d) => d && d.start && d.end && today >= d.start && today <= d.end);
    if (week) {
      const key = `${_liveWarmYear}|${week.start}|${week.end}`;
      // Only worth warming while something is actually in progress; an all-Final slate is
      // already served from the immutable boxscore cache.
      const prev = _liveSnapshots.get(key);
      if (!prev || (prev.games || []).some((g) => g.state === 'Live')) {
        await getLiveWeekSnapshot(_liveWarmYear, week.start, week.end, buildIdToWmmcName(sd), mlbIdMapFingerprint(sd));
      }
    }
  } catch (e) {
    console.error('[Live] warm tick failed:', e.message);
  }
  if (Date.now() < _liveWarmUntil && !_liveWarmTimer) {
    _liveWarmTimer = setTimeout(liveWarmTick, LIVE_WARM_INTERVAL_MS);
    if (_liveWarmTimer.unref) _liveWarmTimer.unref();
  }
}

// GET /api/mlb/live?year=2026
// Live scoring snapshot for the schedule week that contains today's date.
// Combines the in-progress + final games' boxscore stats with the upcoming Preview games
// so the UI can render running totals plus a "games left" indicator per manager.
//
// Unlike /preview or /sync this endpoint includes Live games and is safe to poll on a
// short interval (~60s). It's read-only — nothing is written to the database. The MLB
// half of the work is served from the shared cache above, so poll cost does not scale
// with the number of managers watching; the roster/scoring half is recomputed per request.
app.get('/api/mlb/live', async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  // The live day, not the ET calendar date — see resolveLiveDay. A slate that started last
  // night keeps this view through the following morning, so `today` here means "the game day
  // being shown" and every date comparison below (active week, roster asOf, today_score,
  // per-team ACTIVE/DONE/REMAINING) hangs off it.
  const liveDay = await resolveLiveDay();
  const today = liveDay.live_day;

  // Find the schedule week whose [start, end] contains the live day. During the hold-over
  // window this is still LAST week on a Monday morning, which is the point: the just-finished
  // week stays on screen until the new slate is about to start.
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
      ...liveDay,
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

    // The week's schedule + every Live/Final boxscore in it, shared across all managers
    // watching. Preview games have no stats yet, so the snapshot skips them.
    noteLiveInterest(year);
    const snapshot = await getLiveWeekSnapshot(year, start, end, idToWmmcName, mlbIdMapFingerprint(sd));
    const games = snapshot.games;

    // Aggregate the snapshot's per-game stats into weekly running totals.
    // Keyed by `${wmmcName}::${type}` so two-way players (e.g. Ohtani) get separate
    // batting and pitching entries instead of colliding into one row.
    const playerAgg = {};
    for (const game of snapshot.gameStats) {
      const { batting, pitching } = game;

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

    // Per-manager rosters for the active week, derived from the roster_dates windows scoped to this
    // period (see buildWeekRostersFromDates). Shared with the per-game box score endpoint so both
    // views attribute players to the same managers. Evaluated AS OF THE LIVE DAY, not the week's
    // end: a SCHEDULED (future-dated) swap is recorded the moment it is submitted, so bounding by
    // the week end would apply it early — dropping a player who is still rostered (and still
    // scoring) and adding one who isn't on yet. today is inside [start, end] by construction (that
    // is how activeIdx was picked).
    //
    // Using the live day rather than the calendar date also keeps the hold-over window internally
    // consistent: at 3am, a swap stamped add_date = the new calendar date must NOT retroactively
    // join last night's roster, and the player it replaced must keep the points he actually earned
    // in the games still on screen. The new roster takes over when the day does, at the rollover.
    const asOf = today;
    const {
      managerBatters,
      managerPitchers,
      // Reverse index for player→manager attribution this week. findManagerForPlayer* read the
      // (usually empty) sd.rosters arrays and would attribute nothing, so without this the
      // per-player scoring (Daily/Weekly + the expand panels) stays at zero.
      managerByPlayer: weekManagerByPlayer,
      rosterWindowByPlayer,
    } = buildWeekRostersFromDates(sd, weekRound, weekName, asOf);

    // Games that fall inside a player's own roster window, both bounds inclusive (add_date is the
    // first day he scores, drop_date the last). Scoring off the window rather than player_dates
    // matters here: player_dates is written by syncPlayerDatesFromRosterDates during a sync, and
    // this read-only endpoint never runs that — so on a season whose entries are absent or stale,
    // isDateEligibleForPlayer falls back to the whole week and would credit a dropped player for
    // days he was not on the roster. The windows are the invariant's source of truth anyway.
    const gamesInRosterWindow = (name, games) => {
      const w = rosterWindowByPlayer[name.toLowerCase()];
      if (!w) return games;
      return games.filter((g) => (!w.add || g.date >= w.add) && (!w.drop || g.date <= w.drop));
    };

    // Resolve manager + team for each player and compute running scores.
    // Only include rostered players in the live view — unrostered names are noise here.
    const playerRows = [];
    for (const [, agg] of Object.entries(playerAgg)) {
      const { name } = agg;
      // Only show players whose roster membership was derived from this week's roster_dates
      // + stored arrays (already drop-filtered above). The findManagerForPlayer* fallbacks
      // search ALL weeks' rosters and would re-introduce players dropped in prior weeks.
      const manager = weekManagerByPlayer[`${name.toLowerCase()}::${agg.type}`];
      if (!manager) continue;
      // Skip players dropped in an earlier week but carried forward into this week's roster
      // object — they are excluded from the certified total, so they must not appear here either.
      if (wasDroppedBeforeWeek(sd, manager, name, `${weekRound}|${weekName}`, start)) continue;
      const teamMap = agg.type === 'batting' ? sd.batters_team : sd.pitchers_team;
      // Score only the games inside this player's roster window. A mid-week add or drop must not
      // be credited for days outside it, and the week's running total has to agree with the daily.
      const ownGames = gamesInRosterWindow(name, agg.games);
      const windowStats = {};
      for (const g of ownGames) {
        for (const k of Object.keys(g.stats || {})) windowStats[k] = (windowStats[k] || 0) + (g.stats[k] || 0);
      }
      const score = agg.type === 'batting' ? calculateBattingScore(windowStats) : calculatePitchingScore(windowStats);
      const hasLive = ownGames.some((g) => g.state === 'Live');
      const hasFinal = ownGames.some((g) => g.state === 'Final');
      // today_score = sum of just today's game contributions, so the standings can show
      // both this week's total and what a manager added in the current day. A player whose
      // drop_date IS today still counts today — drop_date is his last rostered day — while one
      // dropped earlier, or not yet effective, contributes nothing because the window excludes it.
      // player_dates still applies on top as the commissioner's manual per-date override.
      const eligibleToday = isDateEligibleForPlayer(sd, name, agg.type, weekRound, weekName, today);
      const todayScore = eligibleToday
        ? ownGames.filter((g) => g.date === today).reduce((s, g) => s + (g.game_score || 0), 0)
        : 0;
      // How much of todayScore the nightly sync has already folded into the certified
      // scoreboard. Non-zero once the 4am sync has run for the day on screen — which is the
      // normal state during the hold-over window, when Live still shows last night's slate.
      const certifiedToday = eligibleToday
        ? certifiedDailyScoreForDate(sd, name, agg.type, weekRound, weekName, today)
        : 0;
      playerRows.push({
        name,
        manager,
        team: teamMap?.[name] || null,
        type: agg.type,
        running_score: Math.round(score * 100) / 100,
        today_score: Math.round(todayScore * 100) / 100,
        // The slice of today_score not yet in the certified total. This — not today_score — is
        // what gets added to the scoreboard total, so a synced day is never counted twice.
        today_score_pending: Math.round((todayScore - certifiedToday) * 100) / 100,
        today_score_certified: Math.round(certifiedToday * 100) / 100,
        // Windowed, not raw: the client re-filters `games` by date to build the per-manager
        // "today" panel, so shipping games from outside the roster window would let the panel
        // show stats the totals above deliberately exclude.
        stats: windowStats,
        games_played: ownGames.length,
        any_live: hasLive,
        any_final: hasFinal,
        games: ownGames.sort((a, b) => a.date.localeCompare(b.date)),
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
          today_score_pending: 0, // the slice of today_score not yet in the certified scoreboard
          today_score_certified: 0, // the slice the nightly sync has already folded in
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
      m.today_score_pending = Math.round((m.today_score_pending + (row.today_score_pending || 0)) * 100) / 100;
      m.today_score_certified = Math.round((m.today_score_certified + (row.today_score_certified || 0)) * 100) / 100;
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
    // Add only the PENDING slice of the day, not the whole thing. certifiedTotals is rebuilt
    // from the stored daily rows, so any day the nightly sync has already folded in is present
    // there too — adding today_score on top would count it twice. In the morning hold-over
    // window (yesterday's slate still on screen, 4am sync done) the pending slice is 0, which
    // is exactly right: Live's Total then equals the Scoreboard, as it should between slates.
    const liveTotalsMap = {};
    for (const m of Object.keys(certifiedTotals)) {
      const pending = (managerMap[m] && managerMap[m].today_score_pending) || 0;
      liveTotalsMap[m] = certifiedTotals[m] + pending;
    }
    const liveRanks = rankByTotals(liveTotalsMap);

    for (const [m, agg] of Object.entries(managerMap)) {
      const baseRank = baselineRanks[m] ?? null;
      const liveRank = liveRanks[m] ?? null;
      agg.baseline_rank = baseRank;
      agg.live_rank = liveRank;
      agg.rank_delta = baseRank != null && liveRank != null ? baseRank - liveRank : 0;
      agg.certified_total = Math.round((certifiedTotals[m] || 0) * 100) / 100;
      agg.round_total = Math.round(((certifiedTotals[m] || 0) + agg.today_score_pending) * 100) / 100;
      agg.is_active_today = agg.players_active > 0 || agg.players_remaining > 0;
    }

    const managers = Object.values(managerMap).sort((a, b) => b.round_total - a.round_total);

    // True once the nightly sync has certified the day on screen, i.e. the Daily column is
    // already baked into Total and the two views agree. Lets the UI label the day's points as
    // banked rather than implying they're still being added on top.
    const liveDayCertified = [...(sd.daily_batting || []), ...(sd.daily_pitching || [])].some(
      (r) => r.date === today && r.round === weekRound && r.week === weekName
    );

    res.json({
      season: year,
      active_week: { round: weekRound, week: weekName, start, end, week_index: activeIdx },
      today,
      ...liveDay,
      live_day_certified: liveDayCertified,
      // fetched_at is when the MLB data behind this response was actually pulled, not when
      // the response was assembled — a cached snapshot must not claim to be current. age_ms
      // lets the UI say how old the numbers are instead of implying they are live to the second.
      fetched_at: new Date(snapshot.fetchedAt).toISOString(),
      age_ms: Date.now() - snapshot.fetchedAt,
      served_at: new Date().toISOString(),
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
  // for the currently-running WMMC week. If the live day doesn't fall inside a week
  // there is no roster to flag against, so nobody gets tagged.
  // Use the live day (see resolveLiveDay), so a box opened at 1am for a game that started
  // last night resolves against the week — and the roster — that game actually belongs to.
  const today = (await resolveLiveDay()).live_day;
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

  // Who actually holds each player right now, from the period-scoped date windows — the same
  // index /api/mlb/live builds its standings from, so the box-score tags can never name a manager
  // the Live tab isn't showing. This is what keeps eliminated managers off the box score: once the
  // bracket moves on, they have no add inside the current period, so no player resolves to them.
  const { managerByPlayer } = buildWeekRostersFromDates(sd, weekRound, weekName, today);

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
        // Shared with /api/mlb/live — opening a box score while the tab is polling
        // reuses that week's schedule instead of pulling it down again.
        const sched = await fetchWeekSchedule(range.start, range.end);
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
          let manager = managerByPlayer[`${name.toLowerCase()}::batting`] || null;
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
          let manager = managerByPlayer[`${name.toLowerCase()}::pitching`] || null;
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

  // Same guard as the 7am auto-post: without usable season data the post renders as a pool-play
  // "Current Period: Season / No scores recorded yet" shell. Fail loudly instead of
  // pushing that to the league channel.
  if (!hasScoreboardData((db.seasons || {})[year])) {
    return res
      .status(409)
      .json({ error: `Season ${year} has no usable schedule or scores — cannot tell which round to post` });
  }

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

// POST /api/seasons/:year/playoff-odds/recompute — recompute & store playoff
// odds on demand (the 4am sync and the 7am scoreboard post refresh them
// automatically). 409 outside the PP2 Week 4–5 window or once pool play is
// finalized — there is nothing meaningful to compute then.
app.post('/api/seasons/:year/playoff-odds/recompute', requireCommissioner, async (req, res) => {
  const { year } = req.params;
  if (!(readDB().seasons || {})[year]) {
    return res.status(404).json({ error: `Season ${year} not found` });
  }
  try {
    const odds = await ensureFreshPlayoffOdds(year, { force: true, trigger: 'manual' });
    if (!odds) {
      return res.status(409).json({
        error: 'Playoff odds are only computed during PP2 Weeks 4–5, before pool play is finalized.',
      });
    }
    const db = readDB();
    addAuditEntry(db, 'playoff_odds_recompute', { year, date: odds.date, sims: odds.sims }, req.get('X-User-Email'));
    writeDB(db);
    res.json({ ok: true, odds });
  } catch (e) {
    console.error('[PlayoffOdds] Manual recompute failed:', e.message);
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

      if (!hasScoreboardData((db.seasons || {})[requestedYear])) {
        return res.json({ response_type: 'ephemeral', text: `No scoreboard data for ${requestedYear} yet.` });
      }

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

// POST /api/seasons/:year/roster-remove — commissioner "hard remove" of a player from one week.
// Purges the player entirely from that week: the authoritative roster_dates window entry, the
// derived per-week roster-array membership, and the attributed/unattributed weekly stat rows for
// the player+week (mirroring the client's hardRemoveFromRoster).
//
// Why this must be a dedicated endpoint and not ride the full-season save: a hard remove is a
// DELETION, and the full-season POST's stale-save guards re-append any roster_dates entry or weekly
// stat row that is missing from the incoming payload (they can't distinguish a deliberate deletion
// from a stale tab that never had the data). So a remove done through saveSeason was silently
// reverted — the roster_dates entry came back, rebuildRosterArraysFromDates re-added the player to
// the array, and the stat rows were restored — leaving the "removed" player fully rostered after a
// refresh. Mutating the server's authoritative copy here is the only way the deletion sticks.
// Body: { manager, weekKey ('round|week'), player, type ('batters'|'pitchers') }.
app.post('/api/seasons/:year/roster-remove', requireCommissioner, (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const { manager, weekKey, player, type } = req.body || {};
  if (!manager || !weekKey || !player || (type !== 'batters' && type !== 'pitchers')) {
    return res.status(400).json({ error: 'manager, weekKey, player, and type (batters|pitchers) are required' });
  }
  const [round, week] = String(weekKey).split('|');
  if (!round || !week) return res.status(400).json({ error: 'weekKey must be "round|week"' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  // 1. Drop the per-week roster-array membership (derived cache).
  if (
    sd.rosters &&
    sd.rosters[manager] &&
    sd.rosters[manager][weekKey] &&
    Array.isArray(sd.rosters[manager][weekKey][type])
  ) {
    sd.rosters[manager][weekKey][type] = sd.rosters[manager][weekKey][type].filter((p) => p !== player);
  }

  // 2. Delete the authoritative roster_dates window entry. This is the mutation the full-season
  //    save could not express — the save guard re-appends any entry the payload omits.
  if (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) {
    delete sd.roster_dates[manager][weekKey][player];
  }

  // 3. Purge the player's weekly stat rows for this week, attributed to this manager OR unattributed
  //    (a two-way player's batter/pitcher entries have distinct names, so filtering both arrays only
  //    ever touches the matching one).
  if (Array.isArray(sd.weekly_batting)) {
    sd.weekly_batting = sd.weekly_batting.filter(
      (b) => !(b.batter === player && b.round === round && b.week === week && (b.manager === manager || !b.manager))
    );
  }
  if (Array.isArray(sd.weekly_pitching)) {
    sd.weekly_pitching = sd.weekly_pitching.filter(
      (p) => !(p.pitcher === player && p.round === round && p.week === week && (p.manager === manager || !p.manager))
    );
  }

  addAuditEntry(db, 'roster_remove', { year, manager, weekKey, player, type }, req.get('X-User-Email'));
  db.seasons[year] = sd;
  writeDB(db);
  res.json({ ok: true, _rev: computeSeasonRev(sd) });
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
  // The unfiltered form is the client's on-demand source for daily data (Trends, per-week roster
  // windows) now that GET /api/seasons omits daily rows — multi-MB, so ETag/304 + gzip it.
  sendJsonRevalidated(req, res, {
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
      so: parseNum(delta.so || 0),
      lob: parseNum(delta.lob || 0),
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

// Rounds in bracket order, and the weekly/daily `round` keys each one covers. Pool Play is
// two scoring periods (PP1 + PP2) under one bracket stage; every playoff round is its own.
const ROAST_ROUND_KEYS = { PP: ['PP1', 'PP2'], QF: ['QF'], SF: ['SF'], Finals: ['Finals'] };

// The same stages in bracket order — used to find "the period before this one" and to walk a
// manager's tournament forward, round by round.
const ROAST_ROUND_ORDER = ['PP', 'QF', 'SF', 'Finals'];

function roastOrdinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

// "an 86-point win", not "a 86-point win". A number reads with a leading vowel sound when it
// starts with eight (8, 80, 86, 800…) or with eleven/eighteen (11, 18, 110, 1800…).
function roastArticle(n) {
  const digits = String(Math.abs(Math.trunc(Number(n) || 0)));
  return digits.startsWith('8') || digits.startsWith('11') || digits.startsWith('18') ? 'an' : 'a';
}

// League-wide per-round player rankings, split by role, so a roast can say "the 6th-best
// hitter in the round" instead of a bare point total — a total means nothing without knowing
// what a good one looks like.
//
// Ranks ROSTER SLOTS, one entry per (manager, player) pair, using exactly the same ownership
// rule and weekly rows as buildManagerPerformanceForRoast (sd.rosters[manager]['round|week'],
// scoped per row's own round + week), so a player's rank can never disagree with the points
// the roast credits them with. A player who changed hands mid-round therefore appears once per
// manager, each with the points that manager actually got — which is the number being ranked.
// Ties share a rank (1,2,2,4) so two identical lines never read as better and worse.
//
// Also ranks the managers themselves by batting total and by pitching total for the round,
// which is what answers "was he good at hitting or at pitching" rather than just "how many
// points did he score".
function computeRoleRanksForRoast(sd, managerNames, round) {
  const rounds = ROAST_ROUND_KEYS[round] || [round];
  const names = Array.isArray(managerNames) && managerNames.length ? managerNames : Object.keys(sd.rosters || {});

  const owns = (manager, weekKey, role, name) => {
    const r = (sd.rosters || {})[manager];
    if (!r) return false;
    const slot = r[weekKey] || {};
    return ((role === 'batters' ? slot.batters : slot.pitchers) || []).includes(name);
  };

  const batSlots = {};
  const pitSlots = {};
  const mgrBat = {};
  const mgrPit = {};
  for (const m of names) {
    mgrBat[m] = 0;
    mgrPit[m] = 0;
  }

  (sd.weekly_batting || []).forEach((b) => {
    if (!rounds.includes(b.round) || !b.batter) return;
    const weekKey = `${b.round}|${b.week}`;
    for (const m of names) {
      if (!owns(m, weekKey, 'batters', b.batter)) continue;
      const key = `${m}|${b.batter}`;
      batSlots[key] = (batSlots[key] || 0) + (b.weekly_score || 0);
      mgrBat[m] += b.weekly_score || 0;
    }
  });
  (sd.weekly_pitching || []).forEach((p) => {
    if (!rounds.includes(p.round) || !p.pitcher) return;
    const weekKey = `${p.round}|${p.week}`;
    for (const m of names) {
      if (!owns(m, weekKey, 'pitchers', p.pitcher)) continue;
      const key = `${m}|${p.pitcher}`;
      pitSlots[key] = (pitSlots[key] || 0) + (p.weekly_score || 0);
      mgrPit[m] += p.weekly_score || 0;
    }
  });

  const r2 = (n) => Math.round(n * 100) / 100;
  const rankMap = (bucket) => {
    const sorted = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
    const out = {};
    let lastPts = null;
    let lastRank = 0;
    sorted.forEach(([key, pts], i) => {
      const rank = lastPts !== null && r2(pts) === lastPts ? lastRank : i + 1;
      lastPts = r2(pts);
      lastRank = rank;
      out[key] = { rank, of: sorted.length, pts: r2(pts) };
    });
    return out;
  };

  // Every manager's total for every scored date in the round, ranked per date — so a day on a
  // manager's own best/worst list can say where it placed leaguewide ("87.6, 1st of 8"), which
  // is the difference between a good day and a good day that everybody else also had.
  //
  // Built from the daily rows with the SAME ownership rule and the same correction guard as
  // the per-manager totals above, rather than from computeDailyHighLow, so a day's rank can
  // never disagree with the score printed next to it.
  const dayTotals = {};
  const creditDay = (row, role, playerKey, scorer) => {
    if (!rounds.includes(row.round) || !row[playerKey] || !row.date) return;
    if (!countsAsGameDelta(row.delta)) return;
    const weekKey = `${row.round}|${row.week}`;
    for (const m of names) {
      if (!owns(m, weekKey, role, row[playerKey])) continue;
      (dayTotals[row.date] = dayTotals[row.date] || {})[m] = (dayTotals[row.date][m] || 0) + scorer(row.delta || {});
    }
  };
  (sd.daily_batting || []).forEach((r) => creditDay(r, 'batters', 'batter', calculateBattingScore));
  (sd.daily_pitching || []).forEach((r) => creditDay(r, 'pitchers', 'pitcher', calculatePitchingScore));
  const dayRanks = {};
  for (const [date, totals] of Object.entries(dayTotals)) dayRanks[date] = rankMap(totals);

  // Managers who never fielded a roster in the round (eliminated earlier, or inactive) would
  // otherwise rank last at 0 and make everyone else's rank look better than it was.
  const played = (bucket) =>
    Object.fromEntries(Object.entries(bucket).filter(([m]) => (mgrBat[m] || 0) !== 0 || (mgrPit[m] || 0) !== 0));

  return {
    round,
    batters: rankMap(batSlots),
    pitchers: rankMap(pitSlots),
    managerBatting: rankMap(played(mgrBat)),
    managerPitching: rankMap(played(mgrPit)),
    dayRanks,
  };
}

// Day-by-day story of a head-to-head playoff matchup, written from `manager`'s side (the
// eliminated one). A final score alone can't tell a wire-to-wire beatdown apart from a lead
// blown on the last Sunday, and those deserve very different roasts — this supplies the
// difference.
//
// Walks the round's scored dates in order off the `dayRanks` table computeRoleRanksForRoast
// already built — every manager's total for every date in the round, under the same ownership
// rule and stat-correction guard as every other number in the roast. Taking it from there
// rather than re-deriving per date means one build per round for a whole combined post, and
// it can never disagree with the day scores the tables print. Returns null when there is no
// opponent or the round has no scored days.
function computeMatchupNarrativeForRoast(dayRanks, manager, opponent) {
  if (!dayRanks || !manager || !opponent) return null;
  const ordered = Object.keys(dayRanks).sort();
  if (ordered.length === 0) return null;

  const r2 = (n) => Math.round(n * 100) / 100;

  let mine = 0;
  let theirs = 0;
  let leader = null; // who was ahead after the previous scored day
  let leadChanges = 0;
  let myDaysLed = 0;
  let theirDaysLed = 0;
  let myBiggestLead = 0;
  let lostLeadOn = null; // last day the lead flipped TO the opponent
  let scoredDays = 0;

  for (const date of ordered) {
    const row = dayRanks[date] || {};
    if (!row[manager] && !row[opponent]) continue;
    scoredDays++;
    mine += row[manager] ? row[manager].pts : 0;
    theirs += row[opponent] ? row[opponent].pts : 0;

    const nowLeader = mine > theirs ? manager : theirs > mine ? opponent : null;
    if (nowLeader === manager) {
      myDaysLed++;
      myBiggestLead = Math.max(myBiggestLead, mine - theirs);
    } else if (nowLeader === opponent) {
      theirDaysLed++;
    }
    if (nowLeader && leader && nowLeader !== leader) {
      leadChanges++;
      if (nowLeader === opponent) lostLeadOn = date;
    }
    if (nowLeader) leader = nowLeader;
  }
  if (scoredDays === 0) return null;

  const fmtDay = (iso) =>
    new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

  const everLed = myDaysLed > 0;
  const wireToWire = !everLed && theirDaysLed > 0;
  let summary;
  if (wireToWire) {
    summary = `${opponent} led wire-to-wire — ${manager} was never once in front across ${scoredDays} scored days.`;
  } else if (leadChanges === 0) {
    summary = `The lead never changed hands.`;
  } else {
    summary =
      `The lead changed ${leadChanges} time${leadChanges === 1 ? '' : 's'}. ${manager} led on ${myDaysLed} of ` +
      `${scoredDays} scored days and was ahead by as much as ${r2(myBiggestLead)} pts` +
      (lostLeadOn ? `, then lost the lead for good on ${fmtDay(lostLeadOn)}.` : '.');
  }

  return {
    scoredDays,
    leadChanges,
    everLed,
    wireToWire,
    daysLed: myDaysLed,
    opponentDaysLed: theirDaysLed,
    biggestLead: r2(myBiggestLead),
    lostLeadOn,
    lostLeadOnLabel: lostLeadOn ? fmtDay(lostLeadOn) : null,
    finalScore: r2(mine),
    opponentFinalScore: r2(theirs),
    summary,
  };
}

// Build a plain-text performance summary for the given manager in the given round: the
// worst-ranked batters/pitchers (used since the original roast), the top 3 and bottom 3 at
// each position, the manager's own three best and three worst scoring days, and the standout
// individual games — the specific "receipts" the roast bank and the page context draw on.
// Ownership mirrors the original rule exactly: sd.rosters[manager][round|week] arrays, scoped
// per row's own round+week (a derived cache, but the same one this function has always used).
//
// Everything here is derived from this manager's own weekly and daily rows, which is what
// lets the page context afford a full summary for EVERY round the manager played rather than
// just the one they went out in. (The previous version's league-wide day-by-day tally needed
// a computeDailyHighLow sweep per date, which was too expensive to run per round.)
//
// opts.ranks — a computeRoleRanksForRoast result for the same round. When supplied, every
// player comes back carrying their league-wide rank among same-role players, and the
// manager's own batting/pitching ranks for the round are attached.
function buildManagerPerformanceForRoast(sd, manager, round, opts = {}) {
  const { ranks = null } = opts;
  const rounds = ROAST_ROUND_KEYS[round] || [round];
  const rosters = sd.rosters && sd.rosters[manager];

  const ownsBatter = (weekKey, name) => !!rosters && ((rosters[weekKey] || {}).batters || []).includes(name);
  const ownsPitcher = (weekKey, name) => !!rosters && ((rosters[weekKey] || {}).pitchers || []).includes(name);

  const batters = {};
  const pitchers = {};

  (sd.weekly_batting || []).forEach((b) => {
    if (!rounds.includes(b.round)) return;
    if (!b.batter) return;
    if (!rosters) return;
    const weekKey = `${b.round}|${b.week}`;
    if (!ownsBatter(weekKey, b.batter)) return;
    batters[b.batter] = (batters[b.batter] || 0) + (b.weekly_score || 0);
  });

  (sd.weekly_pitching || []).forEach((p) => {
    if (!rounds.includes(p.round)) return;
    if (!p.pitcher) return;
    if (!rosters) return;
    const weekKey = `${p.round}|${p.week}`;
    if (!ownsPitcher(weekKey, p.pitcher)) return;
    pitchers[p.pitcher] = (pitchers[p.pitcher] || 0) + (p.weekly_score || 0);
  });

  const totalBat = Object.values(batters).reduce((s, v) => s + v, 0);
  const totalPit = Object.values(pitchers).reduce((s, v) => s + v, 0);
  const total = Math.round((totalBat + totalPit) * 100) / 100;

  const fmtEntry = ([name, score]) => `${name}: ${Math.round(score * 100) / 100} pts`;
  // Ascending by score = worst first (lowest, incl. negative pitcher scores, sorts first).
  const sortedBattersAsc = Object.entries(batters).sort((a, b) => a[1] - b[1]);
  const sortedPitchersAsc = Object.entries(pitchers).sort((a, b) => a[1] - b[1]);

  // Best/worst single calendar day (batting + pitching combined), AND best/worst single
  // individual game (one rostered player, one date) among this manager's rostered players
  // in the round, from the daily rows — same ownership rule as above. Rows that aren't games
  // (nobody played; or a negative delta, i.e. an MLB stat correction landing on this date)
  // are excluded from BOTH tallies — see countsAsGameDelta. Without that guard the "worst
  // single game" is routinely a correction rather than a performance, and a date on which
  // none of the manager's players took the field shows up as a 0-point "worst day".
  const dayTotals = {};
  const playerGames = [];
  (sd.daily_batting || []).forEach((r) => {
    if (!rounds.includes(r.round) || !r.batter || !r.date) return;
    const weekKey = `${r.round}|${r.week}`;
    if (!ownsBatter(weekKey, r.batter)) return;
    if (!countsAsGameDelta(r.delta)) return;
    const score = Math.round(calculateBattingScore(r.delta || {}) * 100) / 100;
    dayTotals[r.date] = (dayTotals[r.date] || 0) + score;
    playerGames.push({ name: r.batter, type: 'Batter', date: r.date, score });
  });
  (sd.daily_pitching || []).forEach((r) => {
    if (!rounds.includes(r.round) || !r.pitcher || !r.date) return;
    const weekKey = `${r.round}|${r.week}`;
    if (!ownsPitcher(weekKey, r.pitcher)) return;
    if (!countsAsGameDelta(r.delta)) return;
    const score = Math.round(calculatePitchingScore(r.delta || {}) * 100) / 100;
    dayTotals[r.date] = (dayTotals[r.date] || 0) + score;
    playerGames.push({ name: r.pitcher, type: 'Pitcher', date: r.date, score });
  });
  const dayEntries = Object.entries(dayTotals)
    .map(([date, score]) => ({ date, score: Math.round(score * 100) / 100 }))
    .sort((a, b) => a.score - b.score);
  const worstDay = dayEntries.length ? dayEntries[0] : null;
  const bestDay = dayEntries.length ? dayEntries[dayEntries.length - 1] : null;

  const sortedGames = [...playerGames].sort((a, b) => a.score - b.score);
  const worstSingleGame = sortedGames.length ? sortedGames[0] : null;
  const bestSingleGame = sortedGames.length ? sortedGames[sortedGames.length - 1] : null;

  // How many days each player was the best on this roster at their own position, and their
  // biggest single game. "Top hitter on 5 of 14 days" is what separates a player who was
  // steadily useful from one who had a single loud afternoon and hid for the rest of the
  // round — a round total alone cannot tell those apart. Ties on a day credit everyone tied.
  const daysLed = { Batter: {}, Pitcher: {} };
  const bestGame = {};
  const byDateRole = {};
  for (const g of playerGames) {
    const key = `${g.date}|${g.type}`;
    (byDateRole[key] = byDateRole[key] || []).push(g);
    if (!bestGame[g.name] || g.score > bestGame[g.name].score) bestGame[g.name] = { score: g.score, date: g.date };
  }
  for (const games of Object.values(byDateRole)) {
    const top = Math.max(...games.map((g) => g.score));
    for (const g of games) if (g.score === top) daysLed[g.type][g.name] = (daysLed[g.type][g.name] || 0) + 1;
  }

  // Attach the league-wide rank for a (manager, player) slot, so the page context can say
  // "6th-best hitter in the round" next to the points, plus the day-level colour above.
  // Returns null when no rank table was supplied or the player has no slot in it (a season
  // with no rosters cache, say).
  const ranked = (entry, role) => {
    if (!entry) return null;
    const [name, pts] = entry;
    const r = ranks && ranks[role] ? ranks[role][`${manager}|${name}`] : null;
    return {
      name,
      pts: Math.round(pts * 100) / 100,
      rank: r ? r.rank : null,
      of: r ? r.of : null,
      days_led: daysLed[role === 'batters' ? 'Batter' : 'Pitcher'][name] || 0,
      best_game: bestGame[name] || null,
    };
  };
  const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null);
  // Top 3 and bottom 3 at each position. sortedXAsc is worst-first, so the last three
  // reversed are the best three. A roster with fewer than six at a position will overlap
  // between the two lists — the page context de-duplicates rather than printing a name twice.
  const topThree = (sortedAsc, role) =>
    sortedAsc
      .slice(-3)
      .reverse()
      .map((e) => ranked(e, role));
  const bottomThree = (sortedAsc, role) => sortedAsc.slice(0, 3).map((e) => ranked(e, role));
  // Where a day placed among all managers on that date.
  const withDayRank = (d) => {
    const r = ranks && ranks.dayRanks && ranks.dayRanks[d.date] ? ranks.dayRanks[d.date][manager] : null;
    return { ...d, rank: r ? r.rank : null, of: r ? r.of : null };
  };

  return {
    manager,
    round,
    total,
    batting_total: Math.round(totalBat * 100) / 100,
    pitching_total: Math.round(totalPit * 100) / 100,
    batters_ranked_worst_first: sortedBattersAsc.map(fmtEntry),
    pitchers_ranked_worst_first: sortedPitchersAsc.map(fmtEntry),
    best_batter: sortedBattersAsc.length ? fmtEntry(sortedBattersAsc[sortedBattersAsc.length - 1]) : null,
    best_pitcher: sortedPitchersAsc.length ? fmtEntry(sortedPitchersAsc[sortedPitchersAsc.length - 1]) : null,
    // Structured, rank-carrying versions of the same four players, for the page context.
    best_batter_ranked: ranked(lastOf(sortedBattersAsc), 'batters'),
    worst_batter_ranked: ranked(sortedBattersAsc[0] || null, 'batters'),
    best_pitcher_ranked: ranked(lastOf(sortedPitchersAsc), 'pitchers'),
    worst_pitcher_ranked: ranked(sortedPitchersAsc[0] || null, 'pitchers'),
    // Where this manager's bats and arms ranked league-wide in the round.
    batting_rank: ranks && ranks.managerBatting ? ranks.managerBatting[manager] || null : null,
    pitching_rank: ranks && ranks.managerPitching ? ranks.managerPitching[manager] || null : null,
    batter_count: sortedBattersAsc.length,
    pitcher_count: sortedPitchersAsc.length,
    // Top 3 / bottom 3 at each position, each carrying rank, days-led and best game.
    top_batters: topThree(sortedBattersAsc, 'batters'),
    bottom_batters: bottomThree(sortedBattersAsc, 'batters'),
    top_pitchers: topThree(sortedPitchersAsc, 'pitchers'),
    bottom_pitchers: bottomThree(sortedPitchersAsc, 'pitchers'),
    worst_day: worstDay,
    best_day: bestDay,
    scored_days: dayEntries.length,
    // The manager's own three highest- and three lowest-scoring days in the round, best
    // first / worst first, each carrying where that day placed among all managers.
    // dayEntries is ascending, so the tail reversed is the top three.
    top_days: dayEntries.slice(-3).reverse().map(withDayRank),
    bottom_days: dayEntries.slice(0, 3).map(withDayRank),
    worst_single_game: worstSingleGame,
    best_single_game: bestSingleGame,
  };
}

// Pool Play standings context for the page-only roast summary: pool/overall rank, points
// behind the manager's own pool's PP1/PP2 winner, and points behind the wild-card cutoff.
// Reuses the exact same per-manager entries shape and currentQualification() math as the
// playoff-odds engine (ensureFreshPlayoffOdds), so this can never disagree with the real
// standings. PP round only — "pool play wins" and "wild card" don't apply to playoff-round
// eliminations, so callers should skip this for QF/SF/Finals.
// Week-by-week cumulative race between two managers across a set of rounds (['PP1'] for a
// pool race, ['PP1','PP2'] for the wild-card race) — "was manager A ever ahead of manager
// B on the cumulative scoreboard, and which week did that lead disappear". Scopes each
// computeRoundScores call to a single week's rows (still the same authoritative per-manager
// scoring as everywhere else — never the roster-array cache) so this can't drift from the
// real weekly totals. Returns null if the round has no weeks (shouldn't happen for PP1/PP2).
function weeklyRaceForRoast(sd, managerA, managerB, rounds) {
  const weeks = SEASON_SCHEDULE.filter((s) => rounds.includes(s.round));
  if (weeks.length === 0) return null;

  let cumA = 0;
  let cumB = 0;
  let ledThroughWeek = null;
  let weeksLed = 0;
  const weekLabel = (w) => `${w.round} ${w.week}`;

  for (const w of weeks) {
    const bat = (sd.weekly_batting || []).filter((r) => r.round === w.round && r.week === w.week);
    const pit = (sd.weekly_pitching || []).filter((r) => r.round === w.round && r.week === w.week);
    const totals = {};
    for (const row of computeRoundScores(bat, pit, [w.round], sd)) totals[row.manager] = row.total;
    cumA += totals[managerA] || 0;
    cumB += totals[managerB] || 0;
    if (cumA >= cumB) {
      ledThroughWeek = weekLabel(w);
      weeksLed++;
    }
  }

  const lastWeek = weeks[weeks.length - 1];
  const secondToLastWeek = weeks.length > 1 ? weeks[weeks.length - 2] : null;

  return {
    rival: managerB,
    neverLed: ledThroughWeek === null,
    ledThroughWeek,
    weeksLed,
    totalWeeks: weeks.length,
    // Led everywhere except the very last week — the "had it, then lost it at the finish
    // line" storyline the roast leads with when true.
    flippedInFinalWeek: !!(
      ledThroughWeek &&
      secondToLastWeek &&
      ledThroughWeek === weekLabel(secondToLastWeek) &&
      ledThroughWeek !== weekLabel(lastWeek)
    ),
  };
}

// Summarizes a manager's playoff journey UP TO (but not including) the given round, for
// weaving "won his pool in PP2 but crashed out in the Quarterfinals" style irony into
// QF/SF/Finals roasts. Pool Play pedigree (seed, won a pool outright vs. wild card) always
// comes from the same locked confirmed_seeding + currentQualification math as everywhere
// else; prior playoff-round results reuse playoffMatchupResultForRoast for each earlier
// round so they can never disagree with the actual bracket. Returns null for round==='PP'
// (nothing precedes Pool Play) or when confirmed_seeding isn't locked yet.
function pastRoundJourneyForRoast(db, sd, manager, round) {
  if (round === 'PP') return null;
  const managers = (db.managers || []).filter((m) => m.active !== false && m.pool);
  if (!managers.some((m) => m.name === manager)) return null;

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const pp1Totals = {};
  for (const s of computeRoundScores(batting, pitching, ['PP1'], sd)) pp1Totals[s.manager] = s.total;
  const pp2Totals = {};
  for (const s of computeRoundScores(batting, pitching, ['PP2'], sd)) pp2Totals[s.manager] = s.total;
  const entries = managers.map((m) => ({
    manager: m.name,
    pool: m.pool,
    pp1: pp1Totals[m.name] || 0,
    pp2: pp2Totals[m.name] || 0,
  }));
  const qual = currentQualification(entries);

  const seeds =
    sd.confirmed_seeding && Array.isArray(sd.confirmed_seeding.qualifierNames)
      ? sd.confirmed_seeding.qualifierNames
      : null;
  if (!seeds) return null;
  const seedIdx = seeds.indexOf(manager);
  const seed = seedIdx >= 0 ? seedIdx + 1 : null;

  const wonPP1 = qual.pp1Leaders.has(manager);
  const wonPP2 = qual.pp2Leaders.has(manager);

  const priorRoundsForRound = { QF: [], SF: ['QF'], Finals: ['QF', 'SF'] };
  const priorRounds = priorRoundsForRound[round] || [];
  const priorResults = priorRounds
    .map((r) => {
      const result = playoffMatchupResultForRoast(sd, r, manager);
      return result ? { round: r, ...result } : null;
    })
    .filter(Boolean);

  return { seed, wonPP1, wonPP2, wildcard: !wonPP1 && !wonPP2, priorResults };
}

function buildPoolPlayStandingsForRoast(db, sd, manager) {
  const managers = (db.managers || []).filter((m) => m.active !== false && m.pool);
  const me = managers.find((m) => m.name === manager);
  if (!me) return null;

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const pp1Totals = {};
  for (const s of computeRoundScores(batting, pitching, ['PP1'], sd)) pp1Totals[s.manager] = s.total;
  const pp2Totals = {};
  for (const s of computeRoundScores(batting, pitching, ['PP2'], sd)) pp2Totals[s.manager] = s.total;
  const entries = managers.map((m) => ({
    manager: m.name,
    pool: m.pool,
    pp1: pp1Totals[m.name] || 0,
    pp2: pp2Totals[m.name] || 0,
  }));

  const combined = (e) => (e.pp1 || 0) + (e.pp2 || 0);
  const myEntry = entries.find((e) => e.manager === manager);
  if (!myEntry) return null;

  const overallSorted = [...entries].sort((a, b) => combined(b) - combined(a));
  const overallRank = overallSorted.findIndex((e) => e.manager === manager) + 1;

  const poolEntries = entries.filter((e) => e.pool === me.pool);
  const poolSorted = [...poolEntries].sort((a, b) => combined(b) - combined(a));
  const poolRank = poolSorted.findIndex((e) => e.manager === manager) + 1;

  // Named leaders, not just their totals — the roast should be able to say who actually
  // beat this manager, not just "the PP1 pool winner". Left null when THIS manager is the
  // leader (gap is a real 0, but there's no rival to name — "0 pts behind yourself" is
  // nonsense, not a storyline).
  let pp1Leader = null;
  let pp1LeaderTotal = -Infinity;
  let pp2Leader = null;
  let pp2LeaderTotal = -Infinity;
  for (const e of poolEntries) {
    if ((e.pp1 || 0) > pp1LeaderTotal) {
      pp1LeaderTotal = e.pp1 || 0;
      pp1Leader = e.manager;
    }
    if ((e.pp2 || 0) > pp2LeaderTotal) {
      pp2LeaderTotal = e.pp2 || 0;
      pp2Leader = e.manager;
    }
  }
  if (pp1Leader === manager) pp1Leader = null;
  if (pp2Leader === manager) pp2Leader = null;

  const qual = currentQualification(entries);
  // The last name in qualifierNames holds the wild-card cutoff total (cutTotal is literally
  // derived from this same entry in currentQualification) — i.e. the actual manager who
  // took the last playoff spot this manager missed.
  const wildcardRival =
    qual.qualifierNames.length && qual.qualifierNames[qual.qualifierNames.length - 1] !== manager
      ? qual.qualifierNames[qual.qualifierNames.length - 1]
      : null;

  const r2 = (x) => Math.round(x * 100) / 100;
  const pp1_gap = r2(pp1LeaderTotal - (myEntry.pp1 || 0));
  const pp2_gap = r2(pp2LeaderTotal - (myEntry.pp2 || 0));
  const wildcard_gap = r2(qual.cutTotal - combined(myEntry));

  // Whichever of the three "so close" storylines is tightest is the one the page context
  // leads with (and the one the week-by-week race narrative is built for) — a manager who
  // missed the wild card by 5 points but their own pool's PP1 winner by 300 should hear
  // about the 5, not the 300.
  const candidates = [
    { key: 'pp1', label: 'the Pool Play 1 lead', gap: pp1_gap, rival: pp1Leader, weeks: ['PP1'] },
    { key: 'pp2', label: 'the Pool Play 2 lead', gap: pp2_gap, rival: pp2Leader, weeks: ['PP2'] },
    { key: 'wildcard', label: 'the wild card', gap: wildcard_gap, rival: wildcardRival, weeks: ['PP1', 'PP2'] },
  ].filter((c) => c.rival && c.gap >= 0);
  candidates.sort((a, b) => a.gap - b.gap);
  const closest = candidates[0] || null;
  const race = closest ? weeklyRaceForRoast(sd, manager, closest.rival, closest.weeks) : null;

  return {
    pool: me.pool,
    poolRank,
    poolSize: poolEntries.length,
    overallRank,
    totalManagers: entries.length,
    pp1_total: r2(myEntry.pp1 || 0),
    pp2_total: r2(myEntry.pp2 || 0),
    pp1_gap,
    pp1_leader: pp1Leader,
    pp2_gap,
    pp2_leader: pp2Leader,
    wildcard_gap,
    wildcard_rival: wildcardRival,
    closest: closest ? { key: closest.key, label: closest.label, gap: closest.gap, rival: closest.rival } : null,
    race,
  };
}

// Static roast bank used when the Anthropic API is unavailable (no ANTHROPIC_API_KEY, or the
// call failed). Deterministically seeded per manager+round so every eliminated manager gets a
// DIFFERENT roast — the old single hardcoded template made a combined Slack post read like a
// form letter. Each template works the manager's real numbers in: worst performers (always
// available), best performer vs. worst performer ("betrayal"), and single best/worst day
// (when daily rows exist for the round). Templates needing best/day data are only added to
// the pool when that data is present, so nothing ever prints "undefined". With full data
// this pool is ~50 templates deep — deterministic per manager+round, so re-running
// generate-roast after the bank grows can land on a different (but still stable) pick.

// Shared by fallbackRoast and buildRoastPageContext (both display text, not the Claude
// prompt, which spells rounds out differently).
function roastRoundLabel(round) {
  return round === 'PP'
    ? 'Pool Play'
    : round === 'QF'
      ? 'the Quarterfinals'
      : round === 'SF'
        ? 'the Semifinals'
        : 'the Finals';
}

// Same label without the leading article, for the possessive positions the banks use:
// "Casey Curve's Quarterfinals" reads, "Casey Curve's the Quarterfinals" does not. The
// article stays in roastRoundLabel because the far more common "across/in ${roundLabel}"
// phrasings need it — stripping it globally would break those instead.
function roastRoundLabelBare(round) {
  return round === 'PP' ? 'Pool Play' : round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : 'Finals';
}

// Escalating "how much this should sting" per round — used both in the Claude prompt
// (generateRoastWithClaude) and the static playoff-stakes paragraph in
// buildRoastPageContext. A Pool Play exit stings least (nobody's played a single playoff
// game); a Finals loss stings most (a title was right there).
const ROAST_INTENSITY = {
  PP: { level: 'mild', stakes: 'before the games that actually count even started' },
  QF: { level: 'medium-high', stakes: 'in the very first round of the real bracket' },
  SF: { level: 'high', stakes: 'one win away from playing for the championship' },
  Finals: { level: 'maximum', stakes: 'with the Whit Merrifield Memorial Cup itself on the line' },
};

// The three podium finishers (champion, runner-up, 3rd place) become team captains for
// next season's pool-selection draft — a standing league rule, not a joke. Appended as a
// plain reminder sentence to the roast TEXT (not just page_context) so it's visible both
// on the roster page and in the combined Slack post, regardless of which outcome bank
// generated the joke or whether Claude or the fallback wrote it.
const PODIUM_OUTCOMES = new Set(['champion', 'runner_up', 'third']);
function withCaptainReminder(text, manager, outcome) {
  if (!PODIUM_OUTCOMES.has(outcome)) return text;
  return `${text} Reminder: as a top-3 finisher, ${manager} is now a team captain for next year's pool selection process.`;
}

// Entries in perf arrive as "Name: X pts" strings — split them back apart. Shared by
// fallbackRoast and buildRoastPageContext.
function parseRoastEntry(s) {
  const idx = s ? s.lastIndexOf(':') : -1;
  return idx > 0
    ? {
        name: s.slice(0, idx),
        pts: s
          .slice(idx + 1)
          .replace('pts', '')
          .trim(),
      }
    : null;
}

function fmtRoastShortDate(iso) {
  return iso
    ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null;
}

function fallbackRoast(manager, round, perf, matchup, narrative, excludeIds) {
  const worst = parseRoastEntry(perf.batters_ranked_worst_first[0]) ||
    parseRoastEntry(perf.pitchers_ranked_worst_first[0]) || { name: 'their entire roster', pts: perf.total };
  const other =
    parseRoastEntry(perf.pitchers_ranked_worst_first[0]) ||
    parseRoastEntry(perf.batters_ranked_worst_first[0]) ||
    worst;
  const best = parseRoastEntry(perf.best_batter) || parseRoastEntry(perf.best_pitcher);
  const roundLabel = roastRoundLabel(round);
  const roundLabelBare = roastRoundLabelBare(round);
  const worstDayDate = perf.worst_day ? fmtRoastShortDate(perf.worst_day.date) : null;
  const bestDayDate = perf.best_day ? fmtRoastShortDate(perf.best_day.date) : null;

  // Core bank: only needs a worst performer + a total — always available. Every player pts
  // figure is explicitly tied to "across/in ${roundLabel}" and every team total is labeled
  // "${roundLabel} total" so it's never ambiguous which number is the player's own line and
  // which is the manager's full team score for the round.
  const core = [
    () =>
      `${manager} rode ${worst.name} (just ${worst.pts} pts across ${roundLabel}) straight into the offseason. ${perf.total} points as a team was pure "maybe next year." The league thanks you for your donation.`,
    () =>
      `Somewhere out there ${worst.name} is enjoying a lovely summer, blissfully unaware they dragged ${manager} to a ${perf.total}-point team funeral in ${roundLabel}. Pour one out.`,
    () =>
      `${manager} drafted ${worst.name} on purpose, watched them post ${worst.pts} pts across ${roundLabel}, and did nothing about it. A ${perf.total}-point team total later, the playoffs politely declined. Bold strategy.`,
    () =>
      `Autopsy report for ${manager}: cause of death, ${worst.name} (${worst.pts} pts in ${roundLabel}), with an assist from ${other.name}. Time of death: ${roundLabel}. Total team damage: ${perf.total} points.`,
    () =>
      `${manager}'s team scored ${perf.total} points in ${roundLabel}, which sounds like a lot until you remember it wasn't. ${worst.name} chipped in a heroic ${worst.pts} of that. See you at the draft, champ.`,
    () =>
      `Good news: ${manager} no longer has to watch ${worst.name} (${worst.pts} pts across ${roundLabel}) every night. Bad news: the rest of us watched ${manager}'s team score ${perf.total} in ${roundLabel} and call it a season.`,
    () =>
      `${manager}'s ${roundLabelBare} campaign: a ${perf.total}-point team total, ${worst.name} in witness protection at ${worst.pts} pts, and a roster that quit before the group chat did. Eliminated, emphatically.`,
    () =>
      `Legend says ${manager} is still waiting for ${worst.name} to heat up. ${worst.pts} points across all of ${roundLabel} later, the wait continues — from the couch, at a ${perf.total}-point team total. Brutal.`,
    () =>
      `Breaking news out of the WMMC newsroom: local manager ${manager} discovers ${worst.name} is not, in fact, good at baseball. Discovery cost: a ${perf.total}-point ${roundLabelBare} team total and an early flight home. Film at 11.`,
    () =>
      `${manager} went with the "close your eyes and hope" strategy in ${roundLabel}. ${worst.name} posted ${worst.pts} pts for the round, the eyes stayed closed, and a ${perf.total}-point team total said "yeah, that tracks."`,
    () =>
      `Cue the highlight reel — there isn't one. ${manager}'s team put up ${perf.total} points in ${roundLabel} behind ${worst.name}'s ${worst.pts}-point disappearing act, and the round ended before the coffee got cold.`,
    () =>
      `SportsCenter's Not Top 10, entry #1: ${manager}'s ${perf.total}-point ${roundLabelBare} team total, presented by ${worst.name}, who contributed ${worst.pts} of those points and a lifetime of regret.`,
    () =>
      `${manager} really said "trust the process," and the process said ${worst.pts} points across ${roundLabel} from ${worst.name}. Final team tally: ${perf.total}. The process has been fired.`,
    () =>
      `In today's edition of Numbers That Should Be Illegal: ${worst.name} posted ${worst.pts} points across ${roundLabel} for ${manager}, on a ${perf.total}-point team total. Somebody call the commissioner — oh wait, he already saw.`,
    () =>
      `${manager} is the proud owner of a ${perf.total}-point ${roundLabelBare} team exit, sponsored by ${worst.name} (${worst.pts} pts for the round) and a whole lot of denial.`,
    () =>
      `Stand-up bit writes itself: a guy walks into ${roundLabel} with ${worst.name} on his roster... he doesn't walk back out. ${manager}, a ${perf.total}-point team total, thanks for playing.`,
    () =>
      `${manager} chasing a title with ${worst.name} contributing just ${worst.pts} points across ${roundLabel} is like bringing a pool noodle to a sword fight. Team total: ${perf.total}. Somebody had to say it.`,
    () =>
      `The box score doesn't lie: ${worst.name} put up ${worst.pts} points for ${roundLabel}, ${manager}'s whole team put up ${perf.total}, and the round put both of them on a bus home.`,
    () =>
      `${manager}'s ${roundLabelBare} eulogy, one line: here lies a ${perf.total}-point team, survived by ${worst.name}'s ${worst.pts}-point ${roundLabelBare} contribution and absolutely nothing else worth mentioning.`,
    () =>
      `Somebody page a doctor — ${worst.name}'s pulse across ${roundLabel} was ${worst.pts} points and barely detectable, and it still wasn't the sickest thing about ${manager}'s ${perf.total}-point team total.`,
    () =>
      `${manager} looked at ${worst.name}, saw ${worst.pts} points across ${roundLabel}, and thought "yeah, he's due." He was not due. Nobody was due. ${perf.total}-point team total, season over.`,
    () =>
      `Somebody should study ${manager}'s roster construction, purely as a warning. ${worst.name}: ${worst.pts} points across ${roundLabel}. Team: ${perf.total}. Science has a word for this and it's "avoidable."`,
    () =>
      `${worst.name} put up ${worst.pts} points across ${roundLabel} and ${manager} kept running him out there like a man feeding quarters into a broken machine. ${perf.total}-point team total. The machine won.`,
    () =>
      `Here's the thing about ${manager}'s ${perf.total}-point ${roundLabelBare}: it wasn't bad luck. ${worst.name} posted ${worst.pts} points and ${other.name} was right there with him. That's a choice, made repeatedly.`,
    () =>
      `${manager} spent ${roundLabel} waiting on ${worst.name} the way people wait on a bus that was cancelled years ago. ${worst.pts} points for the player, ${perf.total} for the team, zero for the plan.`,
    () =>
      `Fantasy baseball is a game of margins, and ${manager}'s margin was ${worst.name} contributing ${worst.pts} points across ${roundLabel}. The team scraped together ${perf.total} and got shown the door.`,
    () =>
      `If you ever wondered what ${perf.total} points looks like, it looks like ${manager} in ${roundLabel}, squinting at ${worst.name}'s ${worst.pts}-point line and insisting the sample size is small.`,
    () =>
      `${manager} could have started a folding chair in ${worst.name}'s spot and finished within rounding distance of ${worst.pts}. Instead: a ${perf.total}-point team total and a long, quiet drive home from ${roundLabel}.`,
    () =>
      `Roll call for ${manager}'s ${roundLabelBare}: ${worst.name}, ${worst.pts} points, present but not accounted for. ${other.name}, also here, also useless. Team total ${perf.total}. Class dismissed.`,
    () =>
      `${manager} entered ${roundLabel} with a plan and left it with a receipt: ${worst.name}, ${worst.pts} points, no refunds. ${perf.total}-point team total. The league appreciates the business.`,
    () =>
      `The scary part isn't that ${worst.name} posted ${worst.pts} points across ${roundLabel}. It's that ${manager} watched it happen in real time, every day, and did nothing. ${perf.total}-point team total.`,
    () =>
      `${manager}'s ${perf.total}-point ${roundLabelBare} team total is the kind of number that doesn't need a joke attached. But ${worst.name}'s ${worst.pts} points across the round is right there, so here we are.`,
    () =>
      `Somewhere in a parallel universe ${worst.name} is good and ${manager} is still playing. In this one, ${worst.pts} points across ${roundLabel} and a ${perf.total}-point team total sent him packing.`,
    () =>
      `${manager} treated ${roundLabel} like a group project and got matched with ${worst.name} (${worst.pts} pts) and ${other.name}. The grade — ${perf.total} points — is going on the permanent record.`,
    () =>
      `Nobody is saying ${manager} didn't try. We're saying ${worst.name} posted ${worst.pts} points across ${roundLabel}, the team managed ${perf.total}, and trying isn't a stat anybody tracks.`,
    () =>
      `${manager} needed a hero in ${roundLabel} and got ${worst.name} instead — ${worst.pts} points, no cape, no pulse. ${perf.total}-point team total, curtain down.`,
    () =>
      `The ${roundLabelBare} exit interview for ${manager} is one question long: why ${worst.name}? ${worst.pts} points across the round. ${perf.total} for the team. There is no acceptable answer.`,
    () =>
      `${manager} built a roster, ${worst.name} built a ${worst.pts}-point monument to doing nothing across ${roundLabel}, and the ${perf.total}-point team total built a bridge straight out of the tournament.`,
    () =>
      `Every league needs someone to lose to, and ${manager} volunteered with a ${perf.total}-point ${roundLabelBare} team total. ${worst.name} (${worst.pts} pts) seconded the motion. Unanimous.`,
    () =>
      `${manager} will tell you ${roundLabel} came down to a couple of unlucky breaks. It came down to ${worst.name} posting ${worst.pts} points and a ${perf.total}-point team total that never once looked like enough.`,
  ];

  // "Best player betrayal" bank: needs at least one standout performer to contrast with the
  // worst one — skipped entirely (not padded with "undefined") when perf has neither. Every
  // pts figure is explicitly "across ${roundLabel}" and every total is labeled "team total"
  // so it's never ambiguous which number belongs to a player and which to the whole roster.
  const betrayal = best
    ? [
        () =>
          `${manager}'s best player across ${roundLabel} was ${best.name} (${best.pts} pts) — and it still wasn't enough to cover for ${worst.name}'s ${worst.pts}. Team total: ${perf.total}. That's not a roster, that's a hostage situation.`,
        () =>
          `Somewhere ${best.name} is quietly proud of that ${best.pts}-point ${roundLabelBare} effort for ${manager}. Everyone else on the roster heard "carry me" and left the team at ${perf.total} total.`,
        () =>
          `${manager} had ONE guy — ${best.name}, ${best.pts} pts across ${roundLabel} — and built an entire campaign hoping nobody would notice the rest. ${perf.total}-point team total. Everybody noticed.`,
        () =>
          `Even ${best.name}'s ${best.pts}-point ${roundLabelBare} highlight reel couldn't drag ${manager}'s team out of a hole dug by ${worst.name}'s ${worst.pts}. One man can't fix a group project this bad.`,
        () =>
          `${manager}'s ${roundLabelBare}, summarized: ${best.name} shows up (${best.pts} pts), ${worst.name} no-shows (${worst.pts} pts), and the team total — ${perf.total} — reads like a group text nobody answered.`,
        () =>
          `Give ${best.name} credit: ${best.pts} points across ${roundLabel} is actual effort. Give ${manager} nothing, because pairing that with ${worst.name}'s ${worst.pts} added up to a ${perf.total}-point team total and an eviction notice from ${roundLabel}.`,
        () =>
          `${manager} leaned on ${best.name} (${best.pts} pts in ${roundLabel}) so hard the guy needed a chiropractor. Everyone else, led by ${worst.name}'s ${worst.pts}, filed for workers' comp. ${perf.total}-point team total.`,
        () =>
          `Star of the show: ${best.name}, ${best.pts} points across ${roundLabel}. Villain of the show: ${worst.name}, ${worst.pts} points. Box office bomb: ${manager}'s team, ${perf.total} total, out of ${roundLabel} in one weekend.`,
        () =>
          `${manager} built a whole campaign around ${best.name} carrying the load — ${best.pts} points across ${roundLabel} worth — and forgot to check if anyone else on the roster owned a bat. ${perf.total}-point team total. Cancelled after one season.`,
        () =>
          `SportsCenter Top Play: ${best.name} going off for ${best.pts} points in ${roundLabel}. SportsCenter Bottom Line: it didn't matter, because ${manager}'s team finished ${roundLabel} at ${perf.total} total thanks to ${worst.name}.`,
        () =>
          `${manager}'s roster had a ceiling (${best.name}, ${best.pts} pts) and a basement (${worst.name}, ${worst.pts} pts) across ${roundLabel}, and somehow the team total — ${perf.total} — spent the whole round living in the basement. Eviction notice served.`,
        () =>
          `${best.name} did his job across ${roundLabel} — ${best.pts} points, no complaints. ${worst.name} did NOT — ${worst.pts} points, several complaints, mostly from ${manager}, whose team still finished at ${perf.total} total and out the door.`,
        () =>
          `${manager} spent ${roundLabel} pointing at ${best.name}'s ${best.pts}-point line like it excused everything else. It did not. ${worst.name}'s ${worst.pts} made sure of that. ${perf.total}-point team total, case closed.`,
        () =>
          `One-man band alert: ${best.name} put up ${best.pts} points across ${roundLabel} solo for ${manager}, while ${worst.name} sat in the audience posting ${worst.pts}. The team's ${roundLabelBare} show still got booed off stage at a ${perf.total} total.`,
        () =>
          `${manager} had the receipts to prove ${best.name} tried across ${roundLabel} (${best.pts} pts). Nobody asked for the receipts on ${worst.name} (${worst.pts} pts) — they were self-evident. ${perf.total}-point team total, ${roundLabel} over.`,
        () =>
          `${best.name} put up ${best.pts} points across ${roundLabel} and got absolutely nothing for it, because ${manager} paired him with ${worst.name}'s ${worst.pts}. A ${perf.total}-point team total is what betrayal looks like in a spreadsheet.`,
        () =>
          `Imagine being ${best.name}, going out and getting ${best.pts} points across ${roundLabel}, and finding out ${manager}'s team still finished at ${perf.total} because ${worst.name} managed ${worst.pts}. Somebody owes that man an apology.`,
        () =>
          `${manager}'s roster in ${roundLabel} was ${best.name} (${best.pts} pts) and seven guys in witness protection, chief among them ${worst.name} at ${worst.pts}. Team total: ${perf.total}. Manhunt ongoing.`,
        () =>
          `The tragedy of ${manager}'s ${roundLabelBare} isn't the ${perf.total}-point team total. It's that ${best.name} gave him ${best.pts} points of real production and ${worst.name} answered with ${worst.pts}.`,
        () =>
          `${best.name}: ${best.pts} points across ${roundLabel}, no notes. ${worst.name}: ${worst.pts} points, several notes. ${manager}: ${perf.total}-point team total and a flight to book.`,
        () =>
          `Somebody tell ${best.name} his ${best.pts}-point ${roundLabelBare} was wasted on ${manager}, whose ${perf.total}-point team total was busy being dragged under by ${worst.name}'s ${worst.pts}.`,
        () =>
          `${manager} won the lottery with ${best.name} (${best.pts} pts across ${roundLabel}) and then set the ticket on fire by starting ${worst.name} for ${worst.pts}. ${perf.total}-point team total. Astonishing work.`,
        () =>
          `In ${roundLabel}, ${best.name} scored ${best.pts} points and ${worst.name} scored ${worst.pts}. ${manager} rostered both and finished at ${perf.total}. One of those decisions was defensible.`,
        () =>
          `${best.name} carried what he could — ${best.pts} points across ${roundLabel} — but nobody carries ${worst.name}'s ${worst.pts} and a ${perf.total}-point team total up a hill this steep.`,
        () =>
          `The ${roundLabelBare} highlight package for ${manager} is ${best.name} at ${best.pts} points, followed by 40 minutes of ${worst.name} doing ${worst.pts} points' worth of nothing. ${perf.total}-point team total.`,
        () =>
          `${manager} had exactly one asset in ${roundLabel}: ${best.name}, ${best.pts} points. He also had ${worst.name} at ${worst.pts}, which is less an asset than a liability with a jersey. ${perf.total} total, goodbye.`,
        () =>
          `Somebody should check whether ${best.name} knows he played for ${manager} in ${roundLabel}. ${best.pts} points of effort, ${worst.name}'s ${worst.pts} points of company, and a ${perf.total}-point team total to show for it.`,
        () =>
          `${best.name} did ${best.pts} points of work across ${roundLabel}. ${worst.name} did ${worst.pts}. ${manager} did the math wrong all round and ended up at ${perf.total}. Class act, terrible team.`,
        () =>
          `You can build around a guy like ${best.name} (${best.pts} pts in ${roundLabel}). ${manager} instead built around the hope that ${worst.name} would stop posting numbers like ${worst.pts}. ${perf.total}-point team total.`,
        () =>
          `${manager}'s ${roundLabelBare} in two lines: ${best.name}, ${best.pts} points, thank you for your service. ${worst.name}, ${worst.pts} points, please return your equipment. Team total ${perf.total}.`,
      ]
    : [];

  // Best/worst single-day bank: needs both a best day and a worst day from the round's
  // daily rows — historical seasons without daily tracking simply never draw from this pool.
  // None of these claim which day came first chronologically (best_day/worst_day are
  // picked independently by score, not by date order) — no "then"/"before"/"after"/
  // "rally"/"immediately" language that would imply a sequence that may not be true.
  const dayBank =
    perf.best_day && perf.worst_day
      ? [
          () =>
            `${manager}'s ${roundLabelBare} had exactly one good day — ${bestDayDate}, ${perf.best_day.score} pts — and enough bad ones that ${worstDayDate} (${perf.worst_day.score} pts) is the one everyone remembers. ${perf.total} points across the round, ${roundLabel} over.`,
          () =>
            `${manager}'s best day of ${roundLabel} was ${bestDayDate}: ${perf.best_day.score} points, a genuinely good number. His worst was ${worstDayDate}: ${perf.worst_day.score}. Add up every day in between and the round still only came to ${perf.total}, which tells you which of those two days was the impostor.`,
          () =>
            `On ${worstDayDate}, ${manager}'s roster combined for ${perf.worst_day.score} points — a number so bad it makes the ${perf.best_day.score}-point outlier on ${bestDayDate} look like a fluke. Because it was. ${perf.total} points for the round.`,
          () =>
            `SportsCenter's daily leaderboard had ${manager} at ${perf.worst_day.score} points on ${worstDayDate}. That's not a bad beat, that's a crime scene. Even the ${perf.best_day.score}-point day on ${bestDayDate} couldn't post bail. ${perf.total} points across ${roundLabel}.`,
          () =>
            `${manager}'s ${roundLabelBare} is bookended by two numbers: a ${perf.best_day.score}-pt peak on ${bestDayDate} and a ${perf.worst_day.score}-pt crater on ${worstDayDate}. ${perf.total} points of whiplash across the round, and a ticket home either way.`,
          () =>
            `The stand-up bit: "My fantasy team had a great day once." (${bestDayDate}, ${perf.best_day.score} pts.) "Once." Everyone laughs, because ${worstDayDate}'s ${perf.worst_day.score}-point disaster is right there in the box score. ${manager}, ${perf.total} points for the round, done in ${roundLabel}.`,
          () =>
            `${worstDayDate} was so bad for ${manager} (${perf.worst_day.score} pts) that the league observed a moment of silence. The ${perf.best_day.score}-point day on ${bestDayDate} didn't change how the round ended. ${perf.total} points, ${roundLabel} finished.`,
          () =>
            `Somewhere between the ${perf.best_day.score}-point high of ${bestDayDate} and the ${perf.worst_day.score}-point low of ${worstDayDate}, ${manager} never found a competitive roster. ${perf.total} points across the round says it all.`,
          () =>
            `${manager}'s ${roundLabelBare} boils down to two numbers: his best day of the round, ${perf.best_day.score} points on ${bestDayDate}, and his worst, ${perf.worst_day.score} on ${worstDayDate}. The good one came once and never came back; the bad one had plenty of company. Final total ${perf.total}. Cut to black.`,
          () =>
            `A ${perf.best_day.score}-point day on ${bestDayDate} is the kind of number that makes a manager feel like a genius. A ${perf.worst_day.score}-point face-plant on ${worstDayDate} is the kind that reminds everyone he isn't. ${perf.total} points for the round, roster retired.`,
          () =>
            `Somebody get ${manager} a highlight package for ${bestDayDate} (${perf.best_day.score} pts) — it's the only footage from ${roundLabel} that isn't ${worstDayDate}'s ${perf.worst_day.score}-point lowlight reel. ${perf.total} points across the round, show's over.`,
          () =>
            `${manager}'s box score on ${worstDayDate} read ${perf.worst_day.score} points, which is the fantasy equivalent of forgetting to show up to your own game. ${bestDayDate}'s ${perf.best_day.score} wasn't enough of an alibi. ${perf.total} points for the round, ${roundLabel} closed the case.`,
          () =>
            `Two dates sum up ${manager}'s ${roundLabelBare}: the round's high, ${bestDayDate} at ${perf.best_day.score} pts, and its low, ${worstDayDate} at ${perf.worst_day.score}. One of those is a manager looking like a genius, the other is the same manager on the same roster, and the ${perf.total}-point round total sided with the second one.`,
          () =>
            `The line for ${manager}'s ${roundLabelBare} has exactly one blip: a ${perf.best_day.score}-point spike on ${bestDayDate}, next to a ${perf.worst_day.score}-point flatline on ${worstDayDate}. ${perf.total} points for the round. Time of death, ${roundLabel}.`,
          () =>
            `${manager} will bring up ${bestDayDate} (${perf.best_day.score} pts) at every draft party from now until forever. Nobody will let him forget ${worstDayDate} (${perf.worst_day.score} pts) either. ${perf.total} points across the round, ${roundLabel} in the books.`,
          () =>
            `${manager}'s ${roundLabelBare} came with a ceiling (${bestDayDate}, ${perf.best_day.score} pts) and a basement (${worstDayDate}, ${perf.worst_day.score} pts). He spent the round redecorating the basement. ${perf.total} points total.`,
          () =>
            `${manager}'s high-water mark in ${roundLabel} was ${perf.best_day.score} points on ${bestDayDate}. His low was ${perf.worst_day.score} on ${worstDayDate}. Averaging those tells you nothing, which is convenient, because the ${perf.total}-point round total tells you everything.`,
          () =>
            `Best day ${perf.best_day.score} (${bestDayDate}), worst day ${perf.worst_day.score} (${worstDayDate}), and a ${perf.total}-point round in between. ${manager} found every way to lose except an interesting one.`,
          () =>
            `The gap between ${manager}'s best day of ${roundLabel} (${bestDayDate}, ${perf.best_day.score} pts) and his worst (${worstDayDate}, ${perf.worst_day.score}) is wider than his margin for error ever was. A roster that swings that far isn't a strategy, it's a coin. ${perf.total} points, ${roundLabel} done.`,
          () =>
            `${manager} has one screenshot from ${roundLabel} worth keeping: ${bestDayDate}, ${perf.best_day.score} points. He has one he'll be shown forever: ${worstDayDate}, ${perf.worst_day.score}. Round total, ${perf.total}.`,
          () =>
            `A ${perf.worst_day.score}-point day like ${worstDayDate} isn't a slump, it's a statement. ${bestDayDate}'s ${perf.best_day.score} points doesn't retract it. ${manager} finished ${roundLabel} on ${perf.total}.`,
          () =>
            `${manager}'s ${roundLabelBare} produced exactly two memorable numbers — ${perf.best_day.score} on ${bestDayDate} and ${perf.worst_day.score} on ${worstDayDate} — and only one of them gets brought up in polite company. ${perf.total} points for the round.`,
          () =>
            `Fantasy managers dream about days like ${bestDayDate} (${perf.best_day.score} pts). ${manager} also lived through ${worstDayDate} (${perf.worst_day.score} pts), which is the part the ${perf.total}-point round total remembers.`,
          () =>
            `${manager} put ${perf.best_day.score} on the board on ${bestDayDate} and ${perf.worst_day.score} on ${worstDayDate}. One of those is a good day. Neither of them added up to more than ${perf.total} across ${roundLabel}.`,
          () =>
            `The volatility report on ${manager}'s ${roundLabelBare}: a ${perf.best_day.score}-point spike (${bestDayDate}) and a ${perf.worst_day.score}-point sinkhole (${worstDayDate}), for a grand total of ${perf.total} and a grand total of zero wins that mattered.`,
          () =>
            `${manager}'s floor in ${roundLabel} was ${perf.worst_day.score} points on ${worstDayDate}; his ceiling was ${perf.best_day.score} on ${bestDayDate}. A ${perf.total}-point round confirms which of those two he spent most of his time standing on.`,
          () =>
            `If ${manager} could bottle ${bestDayDate} (${perf.best_day.score} pts) he'd still be playing. Instead he bottled ${worstDayDate} (${perf.worst_day.score} pts) and drank it all round. ${perf.total} points, ${roundLabel} over.`,
          () =>
            `${manager}'s ${roundLabelBare} in a single chart would be flat, with one bump on ${bestDayDate} (${perf.best_day.score} pts) and one hole on ${worstDayDate} (${perf.worst_day.score} pts). Area under the curve: ${perf.total}. Not enough.`,
          () =>
            `There's a version of ${roundLabel} where every day looks like ${bestDayDate}'s ${perf.best_day.score} points for ${manager}. There's the real one, where ${worstDayDate} put up ${perf.worst_day.score} and the round finished at ${perf.total}.`,
          () =>
            `${manager}'s best day of the round was ${perf.best_day.score} points on ${bestDayDate}; his worst was ${perf.worst_day.score} on ${worstDayDate}. He talked about the first one all week and nobody had to bring up the second, because the ${perf.total}-point round total said it for him.`,
        ]
      : [];

  // Head-to-head bank: only drawn from on a playoff exit, where there is a named opponent and
  // a day-by-day story. A blown lead and a wire-to-wire beating are different humiliations, so
  // each gets its own lines rather than a generic "you lost" joke.
  // Split into four fixed sub-banks rather than one conditionally-appended array so a
  // template's identity never shifts: h2h-wire:0 is the same joke for every manager, whereas
  // a single array's index 2 would mean different things to a wire-to-wire loser and a
  // blown-lead one. Stable ids are what the no-repeat rule below is built on.
  const h2hBase = matchup
    ? [
        () =>
          `${manager} lost to ${matchup.opponent} ${matchup.myScore}–${matchup.opponentScore} in ${roundLabel}, a ${matchup.margin}-point gap that ${worst.name} (${worst.pts} pts) personally funded. Enjoy the offseason.`,
        () =>
          `${matchup.opponent} needed ${matchup.opponentScore} to end ${manager}'s ${roundLabelBare}. ${manager} answered with ${matchup.myScore} and ${worst.name}'s ${worst.pts}-point contribution. Not close enough, not by ${matchup.margin}.`,
        () =>
          `Final tally in ${roundLabel}: ${matchup.opponent} ${matchup.opponentScore}, ${manager} ${matchup.myScore}. ${worst.name} contributed ${worst.pts} points to that ${matchup.margin}-point hole and not one ounce of shame.`,
        () =>
          `${manager} brought ${matchup.myScore} points to a ${matchup.opponentScore}-point fight. ${matchup.opponent} barely broke a sweat, and ${worst.name}'s ${worst.pts}-point ${roundLabelBare} was the white flag.`,
        () =>
          `The scoreboard says ${matchup.opponent} ${matchup.opponentScore}, ${manager} ${matchup.myScore}. The box score says ${worst.name}, ${worst.pts} points. Both say the same thing: ${roundLabel} is over for ${manager}.`,
        () =>
          `${matchup.margin} points is the distance between ${manager} and ${matchup.opponent} in ${roundLabel}. ${worst.name} (${worst.pts} pts) covered roughly none of it. Pack it up.`,
      ]
    : [];

  const h2hWire =
    matchup && narrative && narrative.wireToWire
      ? [
          () =>
            `${manager} did not lead this ${roundLabelBare} matchup for a single day. Not one. ${matchup.opponent} led wire-to-wire, won ${matchup.opponentScore}–${matchup.myScore}, and ${worst.name}'s ${worst.pts} points made sure it never got interesting.`,
          () =>
            `Wire-to-wire. ${matchup.opponent} took the lead on day one of ${roundLabel} and never gave it back, because ${manager} trotted out ${worst.name} for ${worst.pts} points and called it a plan. ${matchup.opponentScore}–${matchup.myScore}.`,
          () =>
            `Across all ${narrative.scoredDays} scored days of ${roundLabel}, ${manager} was in front for exactly zero of them. ${matchup.opponent} won ${matchup.opponentScore}–${matchup.myScore}. ${worst.name}'s ${worst.pts} points never even threatened to make it a matchup.`,
          () =>
            `You cannot blow a lead you never had. ${manager} trailed ${matchup.opponent} every single day of ${roundLabel} on the way to ${matchup.opponentScore}–${matchup.myScore}, with ${worst.name} chipping in ${worst.pts} points of pure ballast.`,
        ]
      : [];

  const h2hLead =
    matchup && narrative && narrative.everLed && !narrative.wireToWire
      ? [
          () =>
            `${manager} was ahead by as much as ${narrative.biggestLead} points in this ${roundLabelBare} matchup and still found a way to lose it ${matchup.myScore}–${matchup.opponentScore}. ${worst.name} (${worst.pts} pts) held the door open for ${matchup.opponent}.`,
          () =>
            `Blowing a ${narrative.biggestLead}-point lead to ${matchup.opponent} takes real commitment, and ${manager} was committed. ${worst.name} chipped in ${worst.pts} points toward the collapse. ${roundLabel} over, ${matchup.opponentScore}–${matchup.myScore}.`,
          () =>
            `${manager} led this thing. Actually led it, by ${narrative.biggestLead} points. Then ${matchup.opponent} remembered they were playing and won ${matchup.opponentScore}–${matchup.myScore}, while ${worst.name} watched from ${worst.pts} points away.`,
          () =>
            `There is losing, and there is having a ${narrative.biggestLead}-point lead in ${roundLabel} and handing it to ${matchup.opponent} anyway. ${manager} chose the second one. ${worst.name}'s ${worst.pts} points helped enormously.`,
        ]
      : [];

  const h2hClose =
    matchup && matchup.margin <= 25
      ? [
          () =>
            `${matchup.margin} points. That is what separated ${manager} from surviving ${roundLabel}. ${worst.name} posted ${worst.pts}. Do that math slowly, and then think about it every night until next season.`,
          () =>
            `${manager} lost ${roundLabel} by ${matchup.margin}. One decent night from ${worst.name} — who managed ${worst.pts} points — and ${matchup.opponent} is the one writing this eulogy instead.`,
          () =>
            `Losing by ${matchup.margin} to ${matchup.opponent} is the cruellest possible way to end ${roundLabel}, and ${manager} earned every inch of it by starting ${worst.name} for ${worst.pts} points.`,
        ]
      : [];

  // Each template carries a stable id (sub-bank + index) so callers can exclude the ones
  // already used this period, and the one before it, without the banks having to know
  // anything about who else got roasted.
  const withIds = (name, fns) => fns.map((fn, i) => ({ id: `${name}:${i}`, fn }));
  const bank = [
    ...withIds('core', core),
    ...withIds('betrayal', betrayal),
    ...withIds('day', dayBank),
    ...withIds('h2h-base', h2hBase),
    ...withIds('h2h-wire', h2hWire),
    ...withIds('h2h-lead', h2hLead),
    ...withIds('h2h-close', h2hClose),
  ];

  // Seed the choice on manager+round, then walk forward from that slot to the first template
  // not already used nearby. Probing from the natural slot (rather than picking out of a
  // filtered array) matters: filtering renumbers every index, so one manager's stored roast
  // would silently reshuffle everybody else's. This way a manager keeps the same joke run
  // after run, and only an actual collision moves them — to the very next free slot.
  //
  // If every template is excluded (a tiny bank in a very crowded round), fall back to the
  // natural pick: a repeat beats no roast at all.
  const excluded = excludeIds instanceof Set ? excludeIds : new Set();
  let seed = 0;
  for (const c of `${manager}|${round}`) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const startAt = seed % bank.length;
  let pick = bank[startAt];
  for (let step = 0; step < bank.length; step++) {
    const candidate = bank[(startAt + step) % bank.length];
    if (!excluded.has(candidate.id)) {
      pick = candidate;
      break;
    }
  }
  return { templateId: pick.id, text: pick.fn() };
}

// Static fallback for the season CHAMPION (Finals winner) — used when ANTHROPIC_API_KEY is
// unset or the API call fails, same convention as fallbackRoast. Not an elimination joke:
// sarcastic, backhanded "congratulations" that still finds a worst-performer to undercut
// the trophy a little. Deterministically seeded per manager so a champion doesn't get the
// same line every year.
function fallbackChampionRoast(manager, perf) {
  const worst =
    parseRoastEntry(perf.batters_ranked_worst_first[0]) || parseRoastEntry(perf.pitchers_ranked_worst_first[0]);
  const bank = [
    () =>
      `${manager} is your Whit Merrifield Memorial Cup champion, ${perf.total} points in the Finals and all. Even ${worst ? `${worst.name}'s ${worst.pts}-pt dead weight` : 'the weak links'} couldn't stop it. Insufferable, and earned.`,
    () =>
      `Congratulations to ${manager}, champion of the league, owner of a ${perf.total}-point Finals total, and apparently immune to ${worst ? `${worst.name} posting just ${worst.pts} pts` : 'a bad roster spot'}. Enjoy the offseason gloating.`,
    () =>
      `${manager} won the whole thing. ${perf.total} points in the Finals, a trophy, and bragging rights nobody asked to hear about for the next 12 months. ${worst ? `${worst.name} chipped in a modest ${worst.pts} — even champions carry dead weight.` : ''}`,
    () =>
      `Somewhere, a banner is being printed for ${manager}. ${perf.total} Finals points, one Cup, and a level of smugness that was previously theoretical. ${worst ? `${worst.name}'s ${worst.pts} points suggest the margin was closer than the trophy implies.` : ''}`,
    () =>
      `${manager} is this year's champion — ${perf.total} points in the Finals, a Cup on the shelf, and a full year to remind everyone about it. Nobody is happy about this except ${manager}.`,
    () =>
      `The league has a new champion: ${manager}, ${perf.total} points and counting. ${worst ? `${worst.name} still only managed ${worst.pts} — proof that even champions roster a dud.` : 'Flawless, apparently.'}`,
    () =>
      `${manager} hoisted the Whit Merrifield Memorial Cup with a ${perf.total}-point Finals. Deserved? Sure. Going to hear about it forever? Also sure.`,
    () =>
      `Breaking: ${manager} wins the league. ${perf.total} Finals points, a title, and a permanent seat at the head of the draft-party table. ${worst ? `Even ${worst.name}'s ${worst.pts}-pt no-show couldn't dent it.` : ''}`,
    () =>
      `${manager} is champion. Write it down, print it out, frame it — they will remind everyone regardless. ${perf.total} points in the Finals, and a trophy that fits their ego perfectly.`,
    () =>
      `This year's Whit Merrifield Memorial Cup goes to ${manager}: ${perf.total} Finals points and a full season of receipts to back it up. ${worst ? `${worst.name}'s ${worst.pts}-pt contribution says the roster wasn't perfect. The trophy says it didn't matter.` : ''}`,
  ];
  let seed = 0;
  for (const c of `${manager}|champion`) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  return bank[seed % bank.length]();
}

// Static fallback for the manager who WON the 3rd-place game — used when ANTHROPIC_API_KEY
// is unset or the API call fails, same convention as fallbackRoast. Sarcastic "hollow
// victory" framing: a real result, but not the one anyone remembers. `matchup` here is the
// manager's own (winning) 3rd-place-game result. Deterministically seeded per manager.
function fallbackThirdPlaceRoast(manager, perf, matchup) {
  const m = matchup || { opponent: 'the other loser', myScore: perf.total, opponentScore: 0, margin: 0 };
  const bank = [
    () =>
      `${manager} beat ${m.opponent} ${m.myScore}–${m.opponentScore} to win 3rd place. A real, official result, for a game that exists solely because two better teams knocked you both out first.`,
    () =>
      `Congratulations to ${manager} on 3rd place — ${m.myScore}–${m.opponentScore} over ${m.opponent}. Somewhere between "champion" and "also-ran," and closer to the second one.`,
    () =>
      `${manager} won the bronze-medal game ${m.myScore}–${m.opponentScore}. It's a trophy for finishing 3rd out of 12, which is either impressive or a technicality, depending who's asking.`,
    () =>
      `The 3rd-place game went to ${manager}, ${m.myScore}–${m.opponentScore} over ${m.opponent}. Nobody will remember this by next season. ${manager} will remember it forever.`,
    () =>
      `${manager} is your 3rd-place finisher, having beaten ${m.opponent} ${m.myScore}–${m.opponentScore} in the game everyone forgot was even happening.`,
    () =>
      `A real result for ${manager}: 3rd place, ${m.myScore}–${m.opponentScore} over ${m.opponent}. Not a Cup. Not even a runner-up medal. Still, technically, a win.`,
    () =>
      `${manager} finished the season 3rd overall, closing it out ${m.myScore}–${m.opponentScore} over ${m.opponent}. The podium's smallest step, and they're standing on it.`,
    () =>
      `${manager} beat ${m.opponent} ${m.myScore}–${m.opponentScore} for the honor of finishing 3rd. History will record it as a footnote. ${manager} will record it as a highlight.`,
    () =>
      `Bronze goes to ${manager}, ${m.myScore}–${m.opponentScore} over ${m.opponent}. It's the fantasy equivalent of winning the coin flip for who gets the smaller trophy.`,
    () =>
      `${manager} closed the season with a 3rd-place win, ${m.myScore}–${m.opponentScore} over ${m.opponent}. A real accomplishment, filed directly under "not the one that matters."`,
  ];
  let seed = 0;
  for (const c of `${manager}|third`) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  return bank[seed % bank.length]();
}

// How badly a playoff result should read, from the margin alone. Every round's paragraph
// escalates with this: a 2.75-point quarterfinal exit and a 300-point one are completely
// different stories, and flattening both into "lost by X" is what made these read like box
// scores instead of roasts.
function roastMarginTier(margin) {
  if (margin <= 10) return 'heartbreak';
  if (margin <= 25) return 'close';
  if (margin <= 60) return 'competitive';
  if (margin <= 150) return 'clear';
  return 'blowout';
}

// What was on the other side of this particular game, for "X points from ___" phrasing.
function roastStakesOfWinning(round, matchupLabel) {
  if (round === 'QF') return 'the Semifinals';
  if (round === 'SF') return 'the Finals';
  return matchupLabel === 'Championship' ? 'the Whit Merrifield Memorial Cup' : 'a podium finish';
}

// The manager's whole tournament, one stage per entry, in chronological order: Pool Play
// first, then every playoff round they actually played, ending with the round they went out
// in. This is what lets the page context build a section per round instead of collapsing an
// entire season into a single head-to-head line.
//
// The final stage reuses the caller's already-built `perf` (same round, same numbers) rather
// than recomputing it. Earlier stages skip the day-by-day extremes sweep — those only appear
// in the elimination round's paragraph, and computeDailyHighLow-per-date is by far the most
// expensive thing in here. `cache` memoizes the per-round league rank tables across managers
// so the combined-Slack endpoint builds each one once, not once per eliminated manager.
function buildRoundBreakdownsForRoast(db, sd, manager, round, finalPerf, finalMatchup, cache = {}) {
  const endIdx = ROAST_ROUND_ORDER.indexOf(round);
  if (endIdx < 0) return [];

  const stages = [];
  for (let i = 0; i <= endIdx; i++) {
    const r = ROAST_ROUND_ORDER[i];
    const isFinal = r === round;
    const ranks = roastRoundRanks(db, sd, r, cache);
    const perf = isFinal && finalPerf ? finalPerf : buildManagerPerformanceForRoast(sd, manager, r, { ranks });
    // A round this manager never played (eliminated before it, or no rows yet) has nothing to
    // narrate — skip it rather than printing a 0-point section.
    if (!perf || (perf.batter_count === 0 && perf.pitcher_count === 0)) continue;
    const matchup =
      r === 'PP'
        ? null
        : isFinal && finalMatchup !== undefined
          ? finalMatchup
          : playoffMatchupResultForRoast(sd, r, manager);
    // The day-by-day story of THIS round's matchup — a blown lead and a wire-to-wire
    // beating are different humiliations, and every round the manager played deserves the
    // distinction, not just the one they went out in.
    const narrative = matchup ? computeMatchupNarrativeForRoast(ranks.dayRanks, manager, matchup.opponent) : null;
    // Pool Play has no single opponent, so its story line is the shape of the round instead:
    // how often this roster was the best or the worst team in the league on a given day.
    // Counted off the same cached day-rank table, so it agrees with the Scoring days column.
    const dayShape = { days: 0, best: 0, worst: 0 };
    for (const row of Object.values(ranks.dayRanks || {})) {
      const mine = row[manager];
      if (!mine) continue;
      dayShape.days++;
      if (mine.rank === 1) dayShape.best++;
      if (mine.of > 1 && mine.rank === mine.of) dayShape.worst++;
    }
    stages.push({ key: r, label: roastRoundLabelBare(r), isFinal, perf, matchup, narrative, dayShape });
  }
  return stages;
}

// Memoized computeRoleRanksForRoast, keyed by round. Managers come from db.managers — the
// canonical list — never inferred from the roster cache.
function roastRoundRanks(db, sd, round, cache = {}) {
  if (!cache.ranks) cache.ranks = {};
  if (!cache.ranks[round]) {
    const managerNames = (db.managers || []).filter((m) => m.active !== false).map((m) => m.name);
    cache.ranks[round] = computeRoleRanksForRoast(sd, managerNames, round);
  }
  return cache.ranks[round];
}

// Everything the two roast endpoints need for one manager, gathered in one place so they
// can't drift apart: the elimination round's performance (with league ranks attached), the
// Pool Play standings, the head-to-head, the qualifying journey, the day-by-day matchup
// narrative, and the round-by-round breakdown the page context renders as sections.
// `cache` is per-request and memoizes the per-round rank tables across managers — pass the
// same object for every manager in a combined post.
function collectRoastInputs(db, sd, manager, round, cache = {}, opts = {}) {
  const isPlayoffRound = ['QF', 'SF', 'Finals'].includes(round);
  const perf = buildManagerPerformanceForRoast(sd, manager, round, { ranks: roastRoundRanks(db, sd, round, cache) });
  const standings = round === 'PP' ? buildPoolPlayStandingsForRoast(db, sd, manager) : null;
  const matchup = isPlayoffRound
    ? opts.matchup !== undefined
      ? opts.matchup
      : playoffMatchupResultForRoast(sd, round, manager)
    : null;
  const journey = isPlayoffRound ? pastRoundJourneyForRoast(db, sd, manager, round) : null;
  const narrative = matchup
    ? computeMatchupNarrativeForRoast(roastRoundRanks(db, sd, round, cache).dayRanks, manager, matchup.opponent)
    : null;
  const breakdown = buildRoundBreakdownsForRoast(db, sd, manager, round, perf, matchup, cache);
  return { perf, standings, matchup, journey, narrative, breakdown };
}

// Longer, page-only elimination-roast context appended below the joke on the manager's
// roster page — NOT posted to Slack (the combined Slack post already stacks one roast per
// eliminated manager, so it stays short/punchy).
//
// Structured as one labelled section per round the manager actually played, in chronological
// order, so a Semifinals exit reads as a season rather than as a single score: how they
// qualified, what Pool Play looked like, then each playoff round with its own result. Every
// section carries the same three things — the result, the hitting/pitching split with this
// manager's league rank in each, and the best/worst player on that roster ranked against
// every other same-role player in the round — because a raw point total says nothing about
// whether it was any good. Playoff sections escalate with the margin (roastMarginTier): the
// closer the loss, the harder the paragraph leans on it. The elimination round additionally
// gets the standout individual games and the day-by-day tally.
//
// Sections are prefixed with a `[[Label]]` marker that the roster page renders as a heading
// (see the roast block in renderRosterTab, app.js); a paragraph without a marker renders
// plain, which is what keeps roasts stored before this change rendering correctly.
//
// Generated the same way regardless of whether the joke itself came from Claude or
// fallbackRoast — this context is always programmatic. Every sub-bank is only mixed in when
// its data exists, so a season without daily rows / standings / journey / matchup data just
// gets a shorter — but still valid — context, never "undefined".
function buildRoastPageContext(manager, round, perf, standings, matchup, journey, opts = {}) {
  const { breakdown = null, outcome = 'eliminated' } = opts;
  const ordinal = roastOrdinal;
  // The podium roasts (champion, 3rd-place-game winner) are ribbing, not a eulogy — the
  // "and it was all for nothing" framing every other section can use is simply false for them.
  const wentOut = outcome !== 'champion' && outcome !== 'third';

  let seed = 0;
  for (const c of `${manager}|${round}|context`) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const pick = (arr, offset) => arr[(seed + offset) % arr.length]();

  const parts = [];
  // `tables` is keyed by the same section label the text uses, so the roster page can hang
  // each round's tables under its own heading. Kept out of the text rather than encoded into
  // it: the page needs real rows to lay out three tables side by side, and prose that gets
  // parsed back into a table is a bug waiting to happen.
  const tables = {};
  const section = (label, text, rows) => {
    if (!text && !(rows && rows.length)) return;
    parts.push(`[[${label}]] ${text || ''}`.trimEnd());
    if (rows && rows.length) tables[label] = rows;
  };

  // ---- shared sentence builders -------------------------------------------------

  // Where the points came from, and whether that was any good league-wide. `withTotal` is
  // off when the sentence before this one already stated the round score.
  const splitSentence = (p, withTotal) => {
    const rankTag = (r) => (r && r.rank && r.of ? `${ordinal(r.rank)} of ${r.of}` : null);
    const batTag = rankTag(p.batting_rank);
    const pitTag = rankTag(p.pitching_rank);
    const base = withTotal
      ? `${p.total} points in total — ${p.batting_total} from the bats, ${p.pitching_total} from the arms`
      : `The split: ${p.batting_total} from the bats, ${p.pitching_total} from the arms`;
    if (!batTag && !pitTag) return `${base}.`;
    if (batTag && pitTag) {
      return `${base}, which ranked ${batTag} in the league for hitting and ${pitTag} for pitching.`;
    }
    return `${base}, ranking ${batTag || pitTag} in the league for ${batTag ? 'hitting' : 'pitching'}.`;
  };

  // The weakest link on the roster by points, for the "one game from him flips it" math.
  const weakestLink = (p) => {
    const wB = p.worst_batter_ranked;
    const wP = p.worst_pitcher_ranked;
    if (wB && wP) return wB.pts <= wP.pts ? wB : wP;
    return wB || wP || null;
  };

  // The three tables that replace what used to be two dense prose sentences: the manager's
  // own best and worst scoring days, their top performers, and their bottom performers. Every
  // number carries a rank — days against all managers that date, players against every other
  // player at the same position in the round — because a bare total says nothing about whether
  // it was any good.
  //
  // Emitted as structured rows rather than HTML: the roster page builds the DOM and does its
  // own escaping, so a player name out of the MLB feed can never inject markup.
  const rankCell = (x) => (x && x.rank && x.of ? `${ordinal(x.rank)} of ${x.of}` : '—');

  const roundTables = (p) => {
    const tables = [];

    const dayRows = [];
    for (const d of p.top_days || []) dayRows.push({ cells: [fmtRoastShortDate(d.date), d.score, rankCell(d)] });
    // With five or fewer scored days the two lists are the same days in opposite order.
    if (p.scored_days > 5) {
      for (const d of p.bottom_days || []) {
        dayRows.push({ cells: [fmtRoastShortDate(d.date), d.score, rankCell(d)], low: true });
      }
    }
    if (dayRows.length) {
      tables.push({ title: 'Scoring days', columns: ['Day', 'Pts', 'Rank'], rows: dayRows });
    }

    // Players already shown among the top performers are dropped from the bottom table, so a
    // roster with fewer than six at a position never lists the same name in both. The "Best
    // days" column is top-table only: on a five-hitter roster everybody leads on some day, so
    // that number next to a bottom performer reads as praise and muddles the contrast.
    const shown = new Set();
    const playerRows = (list, role, best) => {
      const out = [];
      for (const x of list || []) {
        if (!x) continue;
        if (best) shown.add(`${role}|${x.name}`);
        else if (shown.has(`${role}|${x.name}`)) continue;
        const cells = [x.name, role === 'batters' ? 'H' : 'P', x.pts, rankCell(x)];
        if (best) cells.push(x.days_led > 0 ? `${x.days_led}` : '');
        out.push({ cells, low: !best });
      }
      return out;
    };

    const topRows = [...playerRows(p.top_batters, 'batters', true), ...playerRows(p.top_pitchers, 'pitchers', true)];
    if (topRows.length) {
      tables.push({ title: 'Top performers', columns: ['Player', '', 'Pts', 'Rank', 'Best days'], rows: topRows });
    }
    const bottomRows = [
      ...playerRows(p.bottom_batters, 'batters', false),
      ...playerRows(p.bottom_pitchers, 'pitchers', false),
    ];
    if (bottomRows.length) {
      tables.push({ title: 'Bottom performers', columns: ['Player', '', 'Pts', 'Rank'], rows: bottomRows });
    }
    return tables;
  };

  // ---- how they qualified -------------------------------------------------------
  if (journey && journey.seed) {
    const pedigree =
      journey.wonPP1 && journey.wonPP2
        ? `arrived as the #${journey.seed} seed after winning both Pool Play periods outright`
        : journey.wonPP1
          ? `arrived as the #${journey.seed} seed after winning Pool Play 1`
          : journey.wonPP2
            ? `arrived as the #${journey.seed} seed after winning Pool Play 2`
            : `snuck into the bracket as the #${journey.seed} wild card`;
    const bank = wentOut
      ? [
          () => `${manager} ${pedigree}. Here is what that pedigree turned out to be worth.`,
          () => `${manager} ${pedigree} — the high point, as it turns out.`,
          () => `${manager} ${pedigree}, and the bracket was not impressed.`,
          () => `On paper, ${manager} ${pedigree}. On the scoreboard, paper burns.`,
        ]
      : [
          () => `${manager} ${pedigree}. For once, the seeding knew what it was doing.`,
          () => `${manager} ${pedigree}, and then went and backed it up. Insufferable.`,
          () => `The road started here: ${manager} ${pedigree}.`,
          () => `${manager} ${pedigree} — and unlike most of this league, made it stick.`,
        ];
    section('Getting here', pick(bank, 11));
  }

  // ---- one section per round actually played ------------------------------------
  const stages =
    Array.isArray(breakdown) && breakdown.length
      ? breakdown
      : [{ key: round, label: roastRoundLabelBare(round), isFinal: true, perf, matchup: matchup || null }];

  stages.forEach((stage) => {
    const p = stage.perf;
    const m = stage.matchup;
    const n = stage.narrative;

    // ---- line 1: what happened -----------------------------------------------
    let resultLine;
    if (stage.key === 'PP' && standings) {
      const closest = standings.closest;
      const otherGaps = [];
      if ((!closest || closest.key !== 'pp1') && standings.pp1_leader && standings.pp1_gap >= 0) {
        otherGaps.push(`${standings.pp1_gap} behind ${standings.pp1_leader} for the Pool Play 1 lead`);
      }
      if ((!closest || closest.key !== 'pp2') && standings.pp2_leader && standings.pp2_gap >= 0) {
        otherGaps.push(`${standings.pp2_gap} behind ${standings.pp2_leader} for the Pool Play 2 lead`);
      }
      if ((!closest || closest.key !== 'wildcard') && standings.wildcard_rival && standings.wildcard_gap >= 0) {
        otherGaps.push(`${standings.wildcard_gap} behind ${standings.wildcard_rival} for the wild card`);
      }
      const otherGapsSentence = otherGaps.length ? ` Also ${otherGaps.join(', and ')}.` : '';
      const place = `${ordinal(standings.poolRank)} of ${standings.poolSize} in Pool ${standings.pool}, ${ordinal(standings.overallRank)} of ${standings.totalManagers} overall`;
      if (closest) {
        const missBank = {
          heartbreak: () =>
            `${manager} finished ${place}, and missed ${closest.label} by ${closest.gap} points. Ten weeks of baseball, decided by less than one good afternoon.`,
          close: () =>
            `${manager} finished ${place} — ${closest.gap} points short of ${closest.label}, behind ${closest.rival}. That is a margin he gets to think about all winter.`,
          competitive: () =>
            `${manager} finished ${place}. The nearest miss was ${closest.label}, ${closest.gap} points behind ${closest.rival} — close enough to have been fixable, far enough that nobody had to sweat it.`,
          clear: () =>
            `${manager} finished ${place}, with ${closest.label} sitting ${closest.gap} points away behind ${closest.rival}. Not a near miss. A gap.`,
          blowout: () =>
            `${manager} finished ${place}. The closest thing to a race was ${closest.label}, ${closest.gap} points off. There was no race.`,
        };
        resultLine = `${missBank[roastMarginTier(closest.gap)]()}${otherGapsSentence}`;
      } else {
        resultLine = `${manager} finished ${place}.${otherGapsSentence}`;
      }
    } else if (stage.key === 'PP') {
      const seedClause =
        journey && journey.seed
          ? journey.wonPP1 || journey.wonPP2
            ? ` Enough to win a pool outright and take the #${journey.seed} seed.`
            : ` Enough for the #${journey.seed} wild card, and not a point more than that.`
          : '';
      resultLine = `${manager} came out of the two Pool Play periods with ${p.total} points.${seedClause}`;
    } else if (m) {
      const tier = roastMarginTier(m.margin);
      const prize = roastStakesOfWinning(stage.key, m.label);
      const art = roastArticle(m.margin);
      const lossBank = {
        heartbreak: () =>
          `${m.opponent} ${m.opponentScore}, ${manager} ${m.myScore}. ${m.margin} points — the entire distance between ${prize} and going home, and smaller than one decent afternoon from anybody on the roster.`,
        close: () =>
          `${m.opponent} took it ${m.opponentScore}–${m.myScore}, ${art} ${m.margin}-point margin. Close enough to replay every night until next season, nowhere near close enough to matter.`,
        competitive: () =>
          `${m.opponent} beat ${manager} ${m.opponentScore}–${m.myScore}, by ${m.margin}. A real matchup, right up until it wasn't.`,
        clear: () =>
          `${m.opponent} won ${m.opponentScore}–${m.myScore}, ${art} ${m.margin}-point gap that never seriously looked like closing.`,
        blowout: () =>
          `${m.opponent} ${m.opponentScore}, ${manager} ${m.myScore}. ${art === 'an' ? 'An' : 'A'} ${m.margin}-point margin isn't a loss, it's a mercy rule.`,
      };
      const winBank = {
        heartbreak: () =>
          `${manager} survived ${m.opponent} ${m.myScore}–${m.opponentScore}, by ${m.margin} points. One ordinary night the other way and this section does not exist.`,
        close: () =>
          `${manager} edged ${m.opponent} ${m.myScore}–${m.opponentScore}, ${art} ${m.margin}-point win that was in doubt to the last day.`,
        competitive: () =>
          `${manager} handled ${m.opponent} ${m.myScore}–${m.opponentScore}, by ${m.margin}. Earned, if not comfortable.`,
        clear: () =>
          `${manager} beat ${m.opponent} ${m.myScore}–${m.opponentScore}, ${art} ${m.margin}-point win with room to spare.`,
        blowout: () =>
          `${manager} ran ${m.opponent} off the field ${m.myScore}–${m.opponentScore}, by ${m.margin}. Briefly, this looked like a manager who knew what he was doing.`,
      };
      resultLine = (m.won ? winBank : lossBank)[tier]();
    } else {
      resultLine = `${manager} put up ${p.total} points across ${roastRoundLabel(stage.key)}.`;
    }

    // ---- line 2: how it actually played out -----------------------------------
    // A head-to-head gets the day-by-day story (a blown lead and a wire-to-wire beating are
    // different humiliations). Pool Play has no single opponent, so it gets the shape of the
    // round instead: how often this roster was the best or the worst in the league on a day.
    let storyLine = '';
    if (m && n) {
      if (n.wireToWire) {
        storyLine = `${m.opponent} was in front from the first day to the last — across ${n.scoredDays} scored days, ${manager} led on exactly none of them.`;
      } else if (n.everLed && n.lostLeadOnLabel && !m.won) {
        storyLine = `He did lead it, by as much as ${n.biggestLead} points, and handed it back for good on ${n.lostLeadOnLabel}. ${n.daysLed} of ${n.scoredDays} scored days in front, and none of the ones that counted.`;
      } else if (n.everLed && m.won && n.leadChanges === 0) {
        storyLine = `He led from the front the whole way — ahead on all ${n.daysLed} of ${n.scoredDays} scored days, by as much as ${n.biggestLead} points.`;
      } else if (n.leadChanges > 0) {
        storyLine = `The lead changed hands ${n.leadChanges} time${n.leadChanges === 1 ? '' : 's'} across ${n.scoredDays} scored days, with ${manager} in front for ${n.daysLed} of them and ahead by as much as ${n.biggestLead}.`;
      } else {
        storyLine = `The lead never changed hands once in ${n.scoredDays} scored days. Whatever this was, it was not a contest.`;
      }
    } else if (stage.dayShape && stage.dayShape.days > 0) {
      const d = stage.dayShape;
      const across = `Across ${d.days} scored days`;
      // Which story the day counts tell depends on how lopsided they are: topping the league
      // four times and bottoming it once is a good team having off nights; three and three is
      // a coin flip; and neither is "two settings and no dial", which only fits a roster that
      // really did live at both extremes.
      let dayBank;
      if (d.best === 0 && d.worst === 0) {
        dayBank = [
          () => `${across} he was never the league's best team and never its worst. Present, and nothing else.`,
          () =>
            `${across} he topped the league exactly zero times and propped it up zero times. Utterly, forgettably average.`,
          () =>
            `${across} he never once led the league for a day, and never once finished last. A flat line with a pulse.`,
        ];
      } else if (d.best > 0 && d.worst === 0) {
        dayBank = [
          () => `${across} he was the league's best team on ${d.best} and never finished a day last.`,
          () =>
            `${across} he led the league outright ${d.best} time${d.best === 1 ? '' : 's'} and never bottomed it once. Consistent, which makes the ending worse.`,
        ];
      } else if (d.worst > 0 && d.best === 0) {
        dayBank = [
          () => `${across} he was the league's worst team on ${d.worst} of them, and never once its best.`,
          () =>
            `${across} he hit the bottom of the league ${d.worst} time${d.worst === 1 ? '' : 's'} and the top never. That is not variance, that is a level.`,
        ];
      } else if (d.best >= d.worst * 2) {
        dayBank = [
          () =>
            `${across} he was the league's best team on ${d.best} and its worst on only ${d.worst}. Mostly very good, occasionally absent.`,
          () =>
            `${across} he topped the league ${d.best} times against ${d.worst} at the bottom — a good team with the odd night off.`,
        ];
      } else if (d.worst >= d.best * 2) {
        dayBank = [
          () =>
            `${across} he was the league's worst team on ${d.worst} and its best on just ${d.best}. The bad days were the pattern; the good ones were the exception.`,
          () =>
            `${across} he bottomed the league ${d.worst} times and topped it ${d.best}. The ratio is the whole story.`,
        ];
      } else {
        dayBank = [
          () =>
            `${across} he was the league's best team on ${d.best} and its worst on ${d.worst} — a roster with two settings and no dial between them.`,
          () =>
            `${across} he led the league ${d.best} times and trailed it ${d.worst}. Whichever version showed up was nobody's decision, least of all his.`,
        ];
      }
      storyLine = pick(dayBank, 5);
    }

    // ---- line 3: where the points came from, and who to blame -------------------
    const bestContributor = (() => {
      const b = p.best_batter_ranked;
      const pi = p.best_pitcher_ranked;
      const score = (x) => (x && x.rank && x.of ? x.rank / x.of : 2);
      if (b && pi) return score(b) <= score(pi) ? { x: b, role: 'hitters' } : { x: pi, role: 'pitchers' };
      if (b) return { x: b, role: 'hitters' };
      return pi ? { x: pi, role: 'pitchers' } : null;
    })();
    const weakest = weakestLink(p);
    const creditBits = [splitSentence(p, stage.key === 'PP' && !standings ? false : true)];
    if (bestContributor) {
      const x = bestContributor.x;
      const where =
        x.rank && x.of ? `${x.pts} pts, ${ordinal(x.rank)} of ${x.of} ${bestContributor.role}` : `${x.pts} pts`;
      const game = x.best_game
        ? `, including ${x.best_game.score} in one game on ${fmtRoastShortDate(x.best_game.date)}`
        : '';
      creditBits.push(
        pick(
          [
            () => `${x.name} carried what there was to carry — ${where}${game}.`,
            () => `The one who showed up was ${x.name}: ${where}${game}.`,
            () => `${x.name} did his part — ${where}${game}.`,
            () => `Credit where it is owed: ${x.name}, ${where}${game}.`,
          ],
          13
        )
      );
    }
    if (weakest && (!bestContributor || weakest.name !== bestContributor.x.name)) {
      const where =
        weakest.rank && weakest.of
          ? `${weakest.pts} pts, ${ordinal(weakest.rank)} of ${weakest.of}`
          : `${weakest.pts} pts`;
      // "Did the opposite" is only true when the weakest link was actually bad. On a strong
      // roster the worst player can still be mid-table leaguewide, and calling that a
      // catastrophe is the kind of overstatement that makes the whole section untrustworthy.
      const reallyBad = !weakest.rank || !weakest.of || weakest.rank > weakest.of * 0.5;
      const flip =
        m && !m.won && m.margin <= 25
          ? ` One ${Math.ceil(m.margin)}-point game out of him and ${manager} is still playing.`
          : '';
      creditBits.push(
        pick(
          reallyBad
            ? [
                () => `${weakest.name} did the opposite: ${where}.${flip}`,
                () => `At the other end, ${weakest.name}: ${where}.${flip}`,
                () => `${weakest.name} was the anchor, and not the useful kind — ${where}.${flip}`,
                () => `Dragging the other way: ${weakest.name}, ${where}.${flip}`,
              ]
            : [
                () => `Nobody was a disaster — the weakest link was ${weakest.name} at ${where}.${flip}`,
                () => `Even the low end held up: ${weakest.name}, ${where}.${flip}`,
              ],
          17
        )
      );
    }
    const creditLine = creditBits.filter(Boolean).join(' ');

    const bits = [resultLine, storyLine, creditLine];

    section(stage.label, bits.filter(Boolean).join('\n'), roundTables(p));
  });

  return { text: parts.join('\n\n'), tables };
}

// Call the Anthropic Messages API to generate a vulgar, personalized roast.
// Fallback text for any outcome, used both when ANTHROPIC_API_KEY is unset and as the
// safety net after a failed/empty Claude call — one place that knows which static bank
// belongs to which outcome so generateRoastWithClaude never has to duplicate the mapping.
// Returns { text, templateId }. templateId identifies the elimination-bank template that was
// used, so callers can persist it and keep the same joke from landing twice in a period (see
// recentFallbackTemplateIds). Champion/third-place roasts are one-per-season, so they have
// nothing to collide with and report a null id.
function fallbackRoastForOutcome(manager, round, perf, outcome, matchup, narrative, excludeIds) {
  if (outcome === 'champion') return { text: fallbackChampionRoast(manager, perf), templateId: null };
  if (outcome === 'third') return { text: fallbackThirdPlaceRoast(manager, perf, matchup), templateId: null };
  return fallbackRoast(manager, round, perf, matchup, narrative, excludeIds);
}

// Fallback-template ids already used in this period or the one immediately before it. Feeding
// this to the bank is what stops two managers eliminated in the same round — or in back-to-back
// rounds — from being handed word-for-word the same joke. Reads the stored roasts, so it works
// even though each manager's roast is generated in its own request.
//
// On a regenerate the current round's stored ids are about to be replaced, so they are not
// excluded (otherwise a re-roll would be forced away from every joke it just legitimately used).
function recentFallbackTemplateIds(sd, round, { includeCurrentRound = true } = {}) {
  const idx = ROAST_ROUND_ORDER.indexOf(round);
  const neighbours = new Set(
    [includeCurrentRound ? round : null, idx > 0 ? ROAST_ROUND_ORDER[idx - 1] : null].filter(Boolean)
  );
  const used = new Set();
  for (const r of Object.values((sd && sd.roasts) || {})) {
    if (r && r.template_id && neighbours.has(r.round)) used.add(r.template_id);
  }
  return used;
}

// The prompt lines that turn point totals into judgements. "Rafael Devers, 123 pts" tells the
// model nothing about whether that was good; "6th of 42 hitters rostered this round" tells it
// everything, and is what produces jokes about the 6th-best hitter failing to cover for the
// 28th. Emits nothing when no rank table was attached to perf (older/partial seasons).
function roastPromptRankLines(perf) {
  const line = (label, p, roleWord) => {
    if (!p || !p.rank || !p.of) return null;
    // days_led says whether a good total was earned steadily or in one loud afternoon —
    // the difference between "carried the team" and "had a game once".
    const days =
      p.days_led > 0 ? `, was this roster's best ${roleWord.slice(0, -1)} on ${p.days_led} separate days` : '';
    return `${label}: ${p.name} — ${p.pts} pts, ${roastOrdinal(p.rank)} of ${p.of} ${roleWord} rostered in this round${days}`;
  };
  const rankTag = (r) => (r && r.rank && r.of ? `${roastOrdinal(r.rank)} of ${r.of} managers` : null);
  const dayList = (days) => (days || []).map((d) => `${fmtRoastShortDate(d.date)} (${d.score})`).join(', ') || null;
  const bestDays = dayList(perf.top_days);
  const worstDays = perf.scored_days > 5 ? dayList(perf.bottom_days) : null;
  const lines = [
    perf.batting_rank || perf.pitching_rank
      ? `League rank for this round: hitting ${rankTag(perf.batting_rank) || 'n/a'}, pitching ${rankTag(perf.pitching_rank) || 'n/a'}`
      : null,
    line('Best hitter', perf.best_batter_ranked, 'hitters'),
    line('Worst hitter', perf.worst_batter_ranked, 'hitters'),
    line('Best pitcher', perf.best_pitcher_ranked, 'pitchers'),
    line('Worst pitcher', perf.worst_pitcher_ranked, 'pitchers'),
    bestDays ? `Their best scoring days this round: ${bestDays}` : null,
    worstDays ? `Their worst: ${worstDays}` : null,
  ].filter(Boolean);
  if (!lines.length) return '';
  return `${lines.join('\n')}\n(Ranks are league-wide against every other player at the same position this round — use them, a bare point total says nothing about whether it was any good.)\n`;
}

async function generateRoastWithClaude(manager, round, perf, outcome, matchup, narrative, excludeIds) {
  if (!ANTHROPIC_API_KEY) return fallbackRoastForOutcome(manager, round, perf, outcome, matchup, narrative, excludeIds);

  const roundLabel =
    round === 'PP' ? 'Pool Play' : round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : round;
  const intensity = ROAST_INTENSITY[round] || ROAST_INTENSITY.PP;

  let prompt;
  if (outcome === 'champion') {
    prompt = `You are the trash-talking announcer for the Whit Merrifield Memorial Cup fantasy baseball league. ${manager} just WON THE CHAMPIONSHIP. Write a sarcastic, backhanded "congratulations" — good-natured ribbing of the winner, not a vicious elimination roast. Reference their worst-performing player(s) by name to take them down a peg. Keep it to 2-3 sentences max.

Champion: ${manager}
Championship result: ${matchup ? `${manager} ${matchup.myScore} – ${matchup.opponentScore} ${matchup.opponent}` : 'won the Finals'}
Total score across the Finals round: ${perf.total} pts (Batting: ${perf.batting_total}, Pitching: ${perf.pitching_total})
Worst batters (lowest scores first): ${perf.batters_ranked_worst_first.slice(0, 3).join(', ') || 'none'}
Worst pitchers (lowest scores first): ${perf.pitchers_ranked_worst_first.slice(0, 3).join(', ') || 'none'}

Write the roast now. No preamble, no labels — just the roast.`;
  } else if (outcome === 'third') {
    prompt = `You are the trash-talking announcer for the Whit Merrifield Memorial Cup fantasy baseball league. ${manager} just WON the 3rd-place game — a real result, but a hollow one (it only exists because two other managers were better than both players in it). Write a sarcastic "congratulations, sort of" roast. Keep it to 2-3 sentences max.

3rd-place finisher: ${manager}
3rd-place game result: ${matchup ? `${manager} ${matchup.myScore} – ${matchup.opponentScore} ${matchup.opponent}` : 'won the 3rd-place game'}
Total score across the Finals round: ${perf.total} pts (Batting: ${perf.batting_total}, Pitching: ${perf.pitching_total})
Worst batters (lowest scores first): ${perf.batters_ranked_worst_first.slice(0, 3).join(', ') || 'none'}
Worst pitchers (lowest scores first): ${perf.pitchers_ranked_worst_first.slice(0, 3).join(', ') || 'none'}

Write the roast now. No preamble, no labels — just the roast.`;
  } else {
    // Head-to-head context (playoff rounds only — a Pool Play exit has no single opponent).
    // The matchup line and the day-by-day narrative are what let the roast be about the GAME
    // — a blown lead, a wire-to-wire beating, a one-point heartbreaker — instead of a
    // context-free list of bad players.
    const matchupLines = matchup
      ? [
          `Matchup: lost to ${matchup.opponent} ${matchup.myScore} – ${matchup.opponentScore} (margin ${matchup.margin} pts)`,
          narrative ? `How it played out: ${narrative.summary}` : null,
          narrative && narrative.everLed && !narrative.wireToWire
            ? `IMPORTANT: ${manager} actually LED this matchup at some point and blew it — lean on that, it is the funniest thing about their exit.`
            : null,
          narrative && narrative.wireToWire
            ? `IMPORTANT: ${manager} never led for a single day — they were behind from the first pitch to the last.`
            : null,
          matchup.margin <= 25
            ? `IMPORTANT: this was agonizingly close (${matchup.margin} pts) — one bad start or one lazy at-bat cost them the round.`
            : null,
        ]
          .filter(Boolean)
          .join('\n')
      : '';

    prompt = `You are the trash-talking announcer for the Whit Merrifield Memorial Cup fantasy baseball league. A manager just got eliminated and deserves a brutal, hilariously vulgar roast. Be savage, specific, and profane. Keep it to 2-3 sentences max.

Make the roast about HOW THEY LOST, not just who was bad. Lead with the matchup story below when there is one — a blown lead, a wire-to-wire beating, or a margin so small it hurts — and use their worst players by name as the reason it happened.

Manager eliminated: ${manager}
Eliminated in: ${roundLabel} — this happened ${intensity.stakes}
Roast intensity for this round: ${intensity.level} (the later the round, the more brutal and personal the roast should get — a Pool Play exit is a shrug, a Finals loss is a gut punch)
${matchupLines ? matchupLines + '\n' : ''}Total score: ${perf.total} pts (Batting: ${perf.batting_total}, Pitching: ${perf.pitching_total})
${roastPromptRankLines(perf)}Worst batters (lowest scores first): ${perf.batters_ranked_worst_first.slice(0, 3).join(', ') || 'none'}
Worst pitchers (lowest scores first): ${perf.pitchers_ranked_worst_first.slice(0, 3).join(', ') || 'none'}

Write the roast now. No preamble, no labels — just the roast.`;
  }

  // Every failure mode lands on the static bank. An HTTP error status was already handled;
  // a network-level rejection (socket reset, DNS blip, TLS failure) was not — it threw past
  // the fallback, out of here, and into the route's catch, which returned a 500 and stored
  // nothing. That is how a manager ends up with no roast at all, and worse: the combined
  // Slack loop catches the throw per manager and falls back to whatever was ALREADY stored,
  // so a blip mid-repost silently puts a manager's previous roast into the new post.
  //
  // The timeout is part of the same guarantee. Without it a hung connection blocks until the
  // platform's socket timeout, and because the combined post generates sequentially (each
  // call is a read-modify-write of db.json), one hang stalls every manager behind it.
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
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
      signal: AbortSignal.timeout(ROAST_API_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('Anthropic API call failed for', manager, '-', e.name, e.message);
    return fallbackRoastForOutcome(manager, round, perf, outcome, matchup, narrative, excludeIds);
  }

  if (!resp.ok) {
    console.error('Anthropic API error:', resp.status, await resp.text().catch(() => ''));
    return fallbackRoastForOutcome(manager, round, perf, outcome, matchup, narrative, excludeIds);
  }

  // A body that arrives truncated or malformed is the same class of failure as a bad status.
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    console.error('Anthropic API returned an unreadable body for', manager, '-', e.message);
    return fallbackRoastForOutcome(manager, round, perf, outcome, matchup, narrative, excludeIds);
  }
  const text = data && data.content && data.content[0] && data.content[0].text;
  // A Claude-written roast has no template id — there is nothing to de-duplicate.
  if (text) return { text, templateId: null };
  return fallbackRoastForOutcome(manager, round, perf, outcome, matchup, narrative, excludeIds);
}

// POST /api/seasons/:year/generate-roast — generate and store an elimination roast (commissioner only)
app.post('/api/seasons/:year/generate-roast', requireCommissioner, async (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const { manager, round } = req.body || {};
  if (!manager || !round) return res.status(400).json({ error: 'manager and round are required' });
  // 'eliminated' (default) is the standard "you're out" roast. 'champion'/'third' are the
  // Finals-round sarcastic winner roasts (season champion, 3rd-place-game winner);
  // 'runner_up' keeps the standard elimination joke (they really did lose the
  // Championship) but gets the podium banner/captain reminder like the other two — only
  // meaningful for round === 'Finals', but harmless if sent for any other round.
  const outcome = ['champion', 'third', 'runner_up'].includes(req.body && req.body.outcome)
    ? req.body.outcome
    : 'eliminated';

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  try {
    const { perf, standings, matchup, journey, narrative, breakdown } = collectRoastInputs(db, sd, manager, round);
    // Exclude this manager's own stored id so a re-roll can move off the joke it already had.
    const exclude = recentFallbackTemplateIds(sd, round);
    const ownId = ((sd.roasts || {})[manager] || {}).template_id;
    if (ownId) exclude.delete(ownId);
    const generated = await generateRoastWithClaude(manager, round, perf, outcome, matchup, narrative, exclude);
    const roastText = withCaptainReminder(generated.text, manager, outcome);
    const context = buildRoastPageContext(manager, round, perf, standings, matchup, journey, {
      breakdown,
      outcome,
    });

    if (!sd.roasts) sd.roasts = {};
    sd.roasts[manager] = {
      round,
      outcome,
      text: roastText,
      page_context: context.text,
      // Structured per-section tables (scoring days, top/bottom performers). Absent on roasts
      // stored before tables existed; the roster page falls back to the text alone.
      page_tables: context.tables,
      template_id: generated.templateId || null,
      generated_at: new Date().toISOString(),
    };

    addAuditEntry(db, 'roast_generated', { year, manager, round, outcome }, req.get('X-User-Email'));
    db.seasons[year] = sd;
    writeDB(db);

    res.json({ roast: roastText, page_context: context.text, page_tables: context.tables });
  } catch (err) {
    console.error('Roast generation error:', err);
    res.status(500).json({ error: 'Failed to generate roast' });
  }
});

const NEXT_ROUND_BY_ROUND = {
  PP: { round: 'QF', label: 'The Quarterfinals', period: 'qf' },
  QF: { round: 'SF', label: 'The Semifinals', period: 'sf' },
  SF: { round: 'Finals', label: 'The Finals / 3rd-place game', period: 'finals' },
};

// Roster lock time for a submission period, formatted for Slack: 5 minutes before the stored
// first-pitch time in sd.period_deadlines (mirroring the client's getPeriodDeadline). The
// zone abbreviation is rendered rather than hardcoded, so it reads EDT in summer and EST in
// the shoulder weeks instead of being wrong for half the season.
function periodLockLabel(sd, period) {
  const firstGame = sd.period_deadlines && sd.period_deadlines[period];
  if (!firstGame) return null;
  const fg = new Date(firstGame);
  if (Number.isNaN(fg.getTime())) return null;
  return new Date(fg.getTime() - 5 * 60 * 1000).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

// One-line deadline reminder for the ROUND-END post. The full submission-window walkthrough
// is deliberately NOT here: a round ends Sunday night and the window doesn't close until the
// following Monday, so instructions posted here are read a week before they can be acted on.
// They now ride the Friday scoreboard post (buildSubmissionWindowBlock) instead, which lands
// while managers can actually do something about it. This keeps only the hard deadline, which
// is worth repeating in both places.
function buildDeadlineReminderLine(sd, round) {
  const next = NEXT_ROUND_BY_ROUND[round];
  if (!next) return '';
  const lock = periodLockLabel(sd, next.period);
  const startIdx = SEASON_SCHEDULE.findIndex((s) => s.round === next.round && s.week === 'Week 1');
  const dates = Array.isArray(sd.schedule_dates) ? sd.schedule_dates : [];
  const startISO = startIdx >= 0 && dates[startIdx] ? dates[startIdx].start : null;

  if (lock) {
    return `:alarm_clock: *Reminder:* rosters for ${next.label} are due by ${lock} — 5 minutes before first pitch.`;
  }
  if (startISO) {
    const day = new Date(startISO + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return `:alarm_clock: *Reminder:* rosters for ${next.label} are due 5 minutes before the first pitch on ${day}.`;
  }
  return `:alarm_clock: *Reminder:* ${next.label} need a fresh roster — rosters do NOT carry over.`;
}

// Slack section telling the surviving managers what happens next: when the round runs, when
// its fresh-roster submission window opens (3 days before Week 1, mirroring the client's
// getPeriodOpenDate), and when rosters lock (5 minutes before the stored first-pitch time in
// sd.period_deadlines, mirroring getPeriodDeadline). Every date comes from the season's own
// schedule_dates; anything missing degrades to a generic line rather than blocking the post.
//
// Keyed off the UPCOMING round descriptor rather than the one that just finished — the
// Friday post knows what starts Monday, not what ended a week ago.
function buildSubmissionInstructionsFor(sd, next) {
  const startIdx = SEASON_SCHEDULE.findIndex((s) => s.round === next.round && s.week === 'Week 1');
  let endIdx = -1;
  SEASON_SCHEDULE.forEach((s, i) => {
    if (s.round === next.round) endIdx = i;
  });
  const dates = Array.isArray(sd.schedule_dates) ? sd.schedule_dates : [];
  const startISO = startIdx >= 0 && dates[startIdx] ? dates[startIdx].start : null;
  const endISO = endIdx >= 0 && dates[endIdx] ? dates[endIdx].end : null;

  // Schedule dates are bare YYYY-MM-DD strings; pin them to noon UTC and format in UTC so
  // the printed calendar day never shifts with the server's timezone.
  const fmtDay = (iso) =>
    new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

  let openStr = null;
  if (startISO) {
    const d = new Date(startISO + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 3);
    openStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  const deadlineStr = periodLockLabel(sd, next.period);

  const lines = [':clipboard: *Playoff managers — what happens next:*'];
  if (startISO && endISO) lines.push(`• ${next.label} run ${fmtDay(startISO)} through ${fmtDay(endISO)}.`);
  else if (startISO) lines.push(`• ${next.label} start ${fmtDay(startISO)}.`);
  lines.push(
    '• Rosters do NOT carry over — every playoff team submits a fresh roster in the app for commissioner approval.'
  );
  if (openStr) lines.push(`• The submission window opens ${openStr}.`);
  if (deadlineStr) lines.push(`• Rosters lock ${deadlineStr} — 5 minutes before first pitch.`);
  else if (startISO) lines.push(`• Rosters lock 5 minutes before the first pitch on ${fmtDay(startISO)}.`);
  return lines.join('\n');
}

// Submission-window block for the FRIDAY daily scoreboard post, three days before a playoff
// round's Monday first pitch. This is where the instructions actually earn their place: the
// window is open, the deadline is the next thing on the calendar, and a manager reading it
// can go submit. The same text used to ride the round-end post, where it landed a full week
// early and was long forgotten by the time it mattered.
//
// Returns '' on every other day, so the caller can append unconditionally.
function buildSubmissionWindowBlock(sd, todayISO) {
  const dates = Array.isArray(sd.schedule_dates) ? sd.schedule_dates : [];
  const upcoming = Object.values(NEXT_ROUND_BY_ROUND);
  for (let i = 1; i < SEASON_SCHEDULE.length; i++) {
    // Period boundaries only — the weeks that open a new submission window.
    if (SEASON_SCHEDULE[i].round === SEASON_SCHEDULE[i - 1].round) continue;
    const startISO = dates[i] && dates[i].start;
    if (!startISO) continue;
    const open = new Date(startISO + 'T12:00:00Z');
    open.setUTCDate(open.getUTCDate() - 3); // Monday start → the Friday before
    if (open.toISOString().slice(0, 10) !== todayISO) continue;
    const next = upcoming.find((n) => n.round === SEASON_SCHEDULE[i].round);
    if (!next) continue; // pool play has its own flow; playoff rounds only
    return buildSubmissionInstructionsFor(sd, next);
  }
  return '';
}

// POST /api/seasons/:year/roasts/slack — post one combined Slack message that opens with
// the playoff field (seed-ordered QF matchups) and then an elimination roast for EVERY
// manager eliminated in a round (commissioner only). Body: { round, qualifiers?,
// eliminated?, regenerate? }. Posts to the SCOREBOARD channel — the same webhook/process
// as the daily score updates — NOT the swap-notification channel.
//
// Self-healing: the roster of shame is derived from sd.eliminated (plus the client-passed
// `eliminated` list as a fallback for the window before the finalize save lands, plus any
// already-stored roasts), and any manager missing a stored roast gets one generated here
// before the post — the first live post silently dropped a manager because it trusted the
// stored roasts alone. `regenerate: true` re-rolls every roast for the round (the repost
// button uses this).
app.post('/api/seasons/:year/roasts/slack', requireCommissioner, async (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const { round, qualifiers, eliminated, regenerate, podium } = req.body || {};
  if (!['PP', 'QF', 'SF', 'Finals'].includes(round)) {
    return res.status(400).json({ error: "round must be one of 'PP', 'QF', 'SF', 'Finals'" });
  }
  if (!SLACK_SCOREBOARD_WEBHOOK_URL) {
    return res.status(503).json({ error: 'Slack webhook not configured' });
  }

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  // Finals-only: the top-3 podium finishers (champion, runner-up, 3rd place) get a
  // distinct roast + banner from a plain elimination — passed explicitly by the client
  // (crownChampionAndRoastFinals) since there's no way to self-heal "this manager is the
  // runner-up" from stored state the way a plain elimination can be. Built before toRoast
  // below so the runner-up (who IS in sd.eliminated, same as 4th place) can be excluded
  // from the Hall of Shame set — they get exactly one roast, not two.
  const podiumList = Array.isArray(podium)
    ? podium.filter((w) => w && typeof w.manager === 'string' && w.manager && PODIUM_OUTCOMES.has(w.outcome))
    : [];
  const podiumManagers = new Set(podiumList.map((w) => w.manager));

  const toRoast = new Set();
  for (const [m, r] of Object.entries(sd.eliminated || {})) if (r === round) toRoast.add(m);
  if (Array.isArray(eliminated)) for (const m of eliminated) if (typeof m === 'string' && m) toRoast.add(m);
  for (const [m, r] of Object.entries(sd.roasts || {})) {
    if (r && r.round === round && r.text && (r.outcome || 'eliminated') === 'eliminated') toRoast.add(m);
  }
  for (const m of podiumManagers) toRoast.delete(m);
  if (toRoast.size === 0 && podiumList.length === 0) {
    return res.status(404).json({ error: `No eliminated managers or stored roasts for round ${round}` });
  }

  // Generate what's missing (or everything, on regenerate) BEFORE composing the post.
  // Texts are generated first against the read-only snapshot, then persisted through a
  // fresh read-modify-write so the slow Anthropic awaits can't clobber writes that landed
  // on other requests in the meantime.
  //
  // Ordered by margin of defeat, narrowest first: the heartbreakers lead, the blowouts
  // close it out. Alphabetical (the old order) buried the best story wherever the alphabet
  // happened to put it. Pool Play has no head-to-head margin, so it stays alphabetical, as
  // does any manager whose matchup can't be resolved (sorted last, then by name).
  const matchupByManager = {};
  if (['QF', 'SF', 'Finals'].includes(round)) {
    for (const m of toRoast) matchupByManager[m] = playoffMatchupResultForRoast(sd, round, m);
  }
  // Live no-repeat set: seeded from what's already stored nearby, then grown as this loop
  // picks templates, because those picks aren't persisted until after the loop finishes.
  const usedTemplateIds = recentFallbackTemplateIds(sd, round, { includeCurrentRound: !regenerate });
  const managerOrder = [...toRoast].sort((a, b) => {
    const ma = matchupByManager[a];
    const mb = matchupByManager[b];
    if (ma && mb && ma.margin !== mb.margin) return ma.margin - mb.margin;
    if (ma && !mb) return -1;
    if (!ma && mb) return 1;
    return a.localeCompare(b);
  });
  const roastByManager = {};
  const freshTexts = {};
  // Shared across every manager in this post so the per-round league rank tables (which are
  // league-wide and therefore identical for everyone) are built once instead of per manager.
  const roastCache = {};
  for (const m of managerOrder) {
    const existing = (sd.roasts || {})[m];
    if (!regenerate && existing && existing.round === round && existing.text) {
      roastByManager[m] = existing.text;
      continue;
    }
    try {
      const { perf, standings, matchup, journey, narrative, breakdown } = collectRoastInputs(
        db,
        sd,
        m,
        round,
        roastCache,
        {
          matchup: matchupByManager[m] || null,
        }
      );
      const generated = await generateRoastWithClaude(
        m,
        round,
        perf,
        'eliminated',
        matchup,
        narrative,
        usedTemplateIds
      );
      if (generated.templateId) usedTemplateIds.add(generated.templateId);
      const text = generated.text;
      const context = buildRoastPageContext(m, round, perf, standings, matchup, journey, {
        breakdown,
        outcome: 'eliminated',
      });
      roastByManager[m] = text;
      freshTexts[m] = { text, context, outcome: 'eliminated', templateId: generated.templateId };
    } catch (e) {
      console.error('Roast generation failed for', m, '-', e.message);
      if (existing && existing.text) roastByManager[m] = existing.text;
    }
  }

  // Podium finishers (champion/runner-up/3rd) — same generate-or-reuse pattern, kept in a
  // separate map so they can get their own Slack section instead of being mixed into the
  // Hall of Shame. All three get the captain-for-next-year reminder appended.
  const podiumRoastByManager = {};
  for (const w of podiumList) {
    const m = w.manager;
    const existing = (sd.roasts || {})[m];
    if (!regenerate && existing && existing.round === round && existing.outcome === w.outcome && existing.text) {
      podiumRoastByManager[m] = existing.text;
      continue;
    }
    try {
      const { perf, matchup, journey, breakdown } = collectRoastInputs(db, sd, m, round, roastCache);
      const generated = await generateRoastWithClaude(m, round, perf, w.outcome, matchup, null, usedTemplateIds);
      const text = withCaptainReminder(generated.text, m, w.outcome);
      const context = buildRoastPageContext(m, round, perf, null, matchup, journey, {
        breakdown,
        outcome: w.outcome,
      });
      podiumRoastByManager[m] = text;
      freshTexts[m] = { text, context, outcome: w.outcome, templateId: generated.templateId };
    } catch (e) {
      console.error('Podium roast generation failed for', m, '-', e.message);
      if (existing && existing.text) podiumRoastByManager[m] = existing.text;
    }
  }

  if (Object.keys(freshTexts).length > 0) {
    const db2 = readDB();
    const sd2 = (db2.seasons || {})[year];
    if (sd2) {
      if (!sd2.roasts) sd2.roasts = {};
      const now = new Date().toISOString();
      for (const [m, { text, context, outcome, templateId }] of Object.entries(freshTexts)) {
        sd2.roasts[m] = {
          round,
          outcome,
          text,
          page_context: context.text,
          page_tables: context.tables,
          template_id: templateId || null,
          generated_at: now,
        };
      }
      db2.seasons[year] = sd2;
      writeDB(db2);
    }
  }

  const entries = managerOrder
    .filter((m) => roastByManager[m])
    .map((m) => [m, { text: roastByManager[m], matchup: matchupByManager[m] || null }]);
  const podiumEntries = podiumList
    .filter((w) => podiumRoastByManager[w.manager])
    .map((w) => [w.manager, { text: podiumRoastByManager[w.manager], outcome: w.outcome }]);
  if (entries.length === 0 && podiumEntries.length === 0) {
    return res.status(500).json({ error: 'Roast generation failed for every eliminated manager' });
  }

  // Playoff-field summary (PP only). Seed order comes from the confirmed_seeding snapshot
  // locked at "End Pool Play"; the client-passed qualifiers list is a fallback for the
  // window where that full-season save hasn't landed server-side yet. QF pairs mirror the
  // client bracket (getSFParticipants): 1v8, 4v5, 3v6, 2v7.
  let summary = '';
  if (round === 'PP') {
    const snapNames =
      sd.confirmed_seeding && Array.isArray(sd.confirmed_seeding.qualifierNames)
        ? sd.confirmed_seeding.qualifierNames
        : null;
    const seeds =
      snapNames || (Array.isArray(qualifiers) && qualifiers.every((q) => typeof q === 'string') ? qualifiers : []);
    if (seeds.length === 8) {
      const pair = (a, b) => `• (${a + 1}) ${seeds[a]} vs (${b + 1}) ${seeds[b]}`;
      summary =
        ':trophy: *The playoff field is set!* Quarterfinal matchups:\n' +
        [pair(0, 7), pair(3, 4), pair(2, 5), pair(1, 6)].join('\n') +
        '\n\n';
    } else if (seeds.length > 0) {
      summary = `:trophy: *The playoff field is set!* Qualifiers by seed: ${seeds
        .map((n, i) => `(${i + 1}) ${n}`)
        .join(', ')}\n\n`;
    }
  } else {
    // Playoff rounds: lead with the actual results — every matchup with both scores, the
    // batting/pitching split, win/loss marks, and who advances. This is the same block the
    // daily scoreboard posts, so Slack can never disagree with itself about who won. Until
    // now a QF or SF round-end post opened straight into the roasts and never once said who
    // had actually advanced.
    const results = buildPlayoffMatchupsSlackText(sd, round, { final: true });
    if (results) summary = `${results}\n\n`;
  }

  // Header intensity escalates with the round (ROAST_INTENSITY): a QF exit is a shrug, an
  // SF exit is a gut punch, a Finals loss gets the biggest send-off of the season.
  const plural = entries.length > 1 ? 's' : '';
  let mainBlock = '';
  if (entries.length > 0) {
    const header =
      round === 'PP'
        ? `:fire: *Pool Play is over.* ${entries.length} manager${plural} missed the playoffs — welcome to the Hall of Shame:`
        : round === 'QF'
          ? `:fire: *Quarterfinals eliminations.* ${entries.length} manager${plural} out in the first round of the bracket — welcome to the Hall of Shame:`
          : round === 'SF'
            ? `:rotating_light: *Semifinals eliminations.* ${entries.length} manager${plural} came within one win of the championship and fell short — welcome to the Hall of Shame:`
            : `:skull: *The season is over.* ${entries.length} manager${plural} finished one game short of the Whit Merrifield Memorial Cup — welcome to the Hall of Shame:`;
    // Slack mrkdwn: each roast as a bolded name, the head-to-head result it came from, then
    // a block-quoted body. The result line means a reader can see WHY someone is in here
    // without scrolling back up to the matchup block. Scores are formatted exactly as the
    // results block formats them (1dp, thousands separators, no trailing .0) so the same
    // number never appears twice in one message wearing two different faces.
    const fmtScore = (n) => {
      const s = n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return s.endsWith('.0') ? s.slice(0, -2) : s;
    };
    const sections = entries.map(([manager, r]) => {
      const head = r.matchup
        ? `*${manager}* — _lost to ${r.matchup.opponent} ${fmtScore(r.matchup.myScore)}–${fmtScore(r.matchup.opponentScore)} (by ${fmtScore(r.matchup.margin)})_`
        : `*${manager}*`;
      return `${head}\n> ${String(r.text).trim().replace(/\n/g, '\n> ')}`;
    });
    mainBlock = `${header}\n\n${sections.join('\n\n')}`;
  }

  // Finals only: a second section for the top-3 podium finishers (champion, runner-up,
  // 3rd place) — not "Hall of Shame" (they're captains for next year, not knocked out),
  // so it gets its own header and trophy emoji.
  let podiumBlock = '';
  if (podiumEntries.length > 0) {
    const podiumPlural = podiumEntries.length > 1 ? 's' : '';
    const podiumHeader = `:trophy: *A word for the podium, because nobody's safe.* ${podiumEntries.length} manager${podiumPlural} finished top-3 this season — and they're your next pool captains:`;
    const podiumSections = podiumEntries.map(
      ([manager, r]) => `*${manager}*\n> ${String(r.text).trim().replace(/\n/g, '\n> ')}`
    );
    podiumBlock = `${podiumHeader}\n\n${podiumSections.join('\n\n')}`;
  }

  // Only the hard deadline rides the round-end post now; the full submission walkthrough
  // moved to the Friday scoreboard post (buildSubmissionWindowBlock), where it is actionable.
  const reminder = buildDeadlineReminderLine(sd, round);
  const messageBody = [summary.trimEnd(), mainBlock, podiumBlock, reminder].filter(Boolean).join('\n\n');

  try {
    await postScoreboardChannelSlack(messageBody);
    // Audit against a fresh read — the roast-persist step above may have written since
    // this handler's first readDB, and writing that stale copy back would undo it.
    const auditDb = readDB();
    addAuditEntry(
      auditDb,
      'roasts_slack_post',
      {
        year,
        round,
        managers: entries.length,
        podium: podiumEntries.length,
        regenerated: Object.keys(freshTexts).length,
      },
      req.get('X-User-Email')
    );
    writeDB(auditDb);
    res.json({
      ok: true,
      round,
      managers: entries.map(([m]) => m),
      podium: podiumEntries.map(([m, r]) => ({ manager: m, outcome: r.outcome })),
    });
  } catch (e) {
    console.error('[Slack] Combined roast post failed:', e.message);
    res.status(500).json({ error: e.message });
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
          so: 0,
          lob: 0,
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

// The first Monday strictly AFTER a bare YYYY-MM-DD date (rounds end on Sundays, so this
// is normally end + 1 day). Pinned to noon UTC so the weekday never shifts with the
// server's timezone.
function mondayAfterISO(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().split('T')[0];
}

// The first Tuesday ON OR AFTER a bare YYYY-MM-DD date (playoff rounds start on Mondays,
// so this is normally start + 1 day).
function tuesdayOnOrAfterISO(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7));
  return d.toISOString().split('T')[0];
}

// Collapse schedule_dates into one {round, start, end} window per round.
function roundDateWindows(scheduleDates) {
  const windows = [];
  for (let i = 0; i < SEASON_SCHEDULE.length && i < scheduleDates.length; i++) {
    const { start, end } = scheduleDates[i] || {};
    if (!start || !end) continue;
    const round = SEASON_SCHEDULE[i].round;
    let w = windows.find((x) => x.round === round);
    if (!w) windows.push((w = { round, start, end }));
    if (start < w.start) w.start = start;
    if (end > w.end) w.end = end;
  }
  return windows;
}

// Decide whether the 7am auto-post should run today and what it should show:
//   { summaryRound } — wrap-up post on the first Monday after a round ends (the last
//     pool-play post after PP2, then one per playoff round), reporting the round that
//     just finished even when the next round's window already contains that Monday.
//   {}              — normal daily post.
//   null            — skip today entirely.
// Pool play posts every day (unchanged). Playoff rounds (QF/SF/Finals) post daily only
// from the first Tuesday on/after the round's start — the round's opening Monday belongs
// to the prior round's wrap-up, and its 7am run would have no games to report yet. Gap
// days (the All-Star break between PP2 and the QF, any post-season stragglers) post
// nothing. PP1's boundary Monday stays a normal daily post: it falls inside PP2's window,
// and pool play keeps posting straight through.
function scoreboardAutoPostPlan(sd, todayISO) {
  const windows = roundDateWindows((sd && sd.schedule_dates) || []);
  if (windows.length === 0) return {}; // no dates configured — preserve the old always-post behavior

  let lastEnded = null;
  for (const w of windows) {
    if (w.end < todayISO && (!lastEnded || w.end > lastEnded.end)) lastEnded = w;
  }
  if (lastEnded && lastEnded.round !== 'PP1' && todayISO === mondayAfterISO(lastEnded.end)) {
    return { summaryRound: lastEnded.round };
  }

  // Opening day. Nobody has played a game yet, so a scoreboard would be all zeroes —
  // post the season-welcome draft roast instead. Checked after the wrap-up branch purely
  // for symmetry; the two can never both match (a round can't end before the season starts).
  const seasonStart = windows.reduce((min, w) => (!min || w.start < min ? w.start : min), null);
  if (seasonStart && todayISO === seasonStart) return { welcome: true };

  const current = windows.find((w) => w.start <= todayISO && todayISO <= w.end);
  if (!current) return null; // between rounds or after the season
  if (current.round === 'PP1' || current.round === 'PP2') return {};
  return todayISO >= tuesdayOnOrAfterISO(current.start) ? {} : null;
}

// Does this season have enough state for a scoreboard post to mean anything?
//
// A process whose db.json has no usable season data still renders a *syntactically valid* but
// completely wrong scoreboard: no round can be resolved, so the post falls back to
// "Current Period: *Season*" with pool-play frames and "_No scores recorded yet._" — the
// pool-play layout, in the middle of the playoffs.
// That state is always a deployment artifact, never real: the staging service (ephemeral
// filesystem, reseeds from managers_seed.json on every deploy) or a mid-deploy production
// instance that came up before its disk/Upstash restore. The 7am `last_scoreboard_post_date`
// claim can't dedupe it either, because that guard lives in the very db.json that is empty.
// So check the data itself before posting, and stay silent when there is nothing to report.
//
// "Enough state" is asked as exactly the question the post itself answers — can we name the
// period this post covers? — by delegating to resolveScoreboardRound. Checking proxies for it
// instead (any schedule entry OR any stat row) let two states through that still rendered the
// shell: a schedule whose weeks are all still in the future, and stat rows in a table the old
// round fallback did not read.
function hasScoreboardData(sd) {
  return resolveScoreboardRound(sd) !== null;
}

// ============================================================
// Season-opening welcome post
// ============================================================
// Fires once, at 7am on the season's first day, before a single game has been played. A
// scoreboard would be all zeroes, so this posts a league-wide roast of the DRAFT instead:
// consensus picks, single-team stacks, near-identical rosters. Deliberately league-wide
// rather than one roast per manager — the per-manager format belongs to eliminations, and a
// full slate of them on day 1 would just get collapsed behind Slack's "View Full Message".

// Draft-day facts, derived from sd.initial_submissions — the canonical origin of PP1 roster
// membership (per the scoring invariant, players enter a roster only via a submission or a
// swap). Unapproved submissions count here: at 7am on opening day the commissioner may not
// have approved anything yet, and this post has no scoring consequence whatsoever.
// Returns null when fewer than two managers have drafted — nothing to compare, no post.
function buildDraftFacts(db, sd) {
  const teamOf = (name) =>
    (sd.batters_team && sd.batters_team[name]) || (sd.pitchers_team && sd.pitchers_team[name]) || null;

  const subs = sd.initial_submissions || {};
  const rosters = [];
  for (const m of db.managers || []) {
    const sub = subs[m.name];
    if (!sub) continue;
    const players = [...(sub.batters || []), ...(sub.pitchers || [])].filter(Boolean);
    if (players.length) rosters.push({ manager: m.name, players });
  }
  if (rosters.length < 2) return null;

  // Who drafted each player.
  const owners = new Map();
  for (const r of rosters) {
    for (const p of r.players) {
      if (!owners.has(p)) owners.set(p, []);
      owners.get(p).push(r.manager);
    }
  }

  // Consensus picks: the guys almost everyone took. Ties break by name so the same draft
  // always produces the same post.
  const byCountThenName = (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]);
  const mostRostered = [...owners.entries()]
    .filter(([, o]) => o.length > 1)
    .sort(byCountThenName)
    .slice(0, 3)
    .map(([name, o]) => ({ name, count: o.length, team: teamOf(name) }));

  // The contrarian: most players nobody else wanted.
  const soloCounts = rosters.map((r) => ({
    manager: r.manager,
    count: r.players.filter((p) => owners.get(p).length === 1).length,
  }));
  soloCounts.sort((a, b) => b.count - a.count || a.manager.localeCompare(b.manager));
  const contrarian = soloCounts[0] && soloCounts[0].count > 0 ? soloCounts[0] : null;

  // Biggest single-team stack on one roster — only interesting at 3+.
  let biggestStack = null;
  for (const r of rosters) {
    const perTeam = {};
    for (const p of r.players) {
      const t = teamOf(p);
      if (t) perTeam[t] = (perTeam[t] || 0) + 1;
    }
    for (const [team, count] of Object.entries(perTeam)) {
      if (count < 3) continue;
      if (
        !biggestStack ||
        count > biggestStack.count ||
        (count === biggestStack.count && r.manager.localeCompare(biggestStack.manager) < 0)
      ) {
        biggestStack = { manager: r.manager, team, count };
      }
    }
  }

  // The two managers who drafted closest to the same team as each other.
  let twins = null;
  for (let i = 0; i < rosters.length; i++) {
    for (let j = i + 1; j < rosters.length; j++) {
      const set = new Set(rosters[j].players);
      const shared = rosters[i].players.filter((p) => set.has(p));
      if (shared.length < 3) continue;
      if (!twins || shared.length > twins.shared) {
        twins = { a: rosters[i].manager, b: rosters[j].manager, shared: shared.length, players: shared.slice(0, 3) };
      }
    }
  }

  return {
    managerCount: rosters.length,
    totalPicks: rosters.reduce((n, r) => n + r.players.length, 0),
    uniquePlayers: owners.size,
    mostRostered,
    contrarian,
    biggestStack,
    twins,
  };
}

// Static welcome roast, assembled straight from the facts. Used when ANTHROPIC_API_KEY is
// unset and as the safety net after a failed Claude call — same convention as fallbackRoast.
function fallbackWelcomeRoast(facts) {
  const lines = [];
  const top = facts.mostRostered[0];
  if (top) {
    lines.push(
      `${top.count} of you drafted *${top.name}*${top.team ? ` (${top.team})` : ''}. Bold. Original. ` +
        `Truly the mark of ${top.count} people who opened the same rankings page.`
    );
  }
  if (facts.biggestStack) {
    lines.push(
      `*${facts.biggestStack.manager}* took ${facts.biggestStack.count} ${facts.biggestStack.team} players, ` +
        `which is less a strategy than a cry for help. One rainout and the season's over.`
    );
  }
  if (facts.twins) {
    lines.push(
      `*${facts.twins.a}* and *${facts.twins.b}* share ${facts.twins.shared} players. ` +
        `At least one of you is redundant and we're all going to find out which.`
    );
  }
  if (facts.contrarian) {
    lines.push(
      `*${facts.contrarian.manager}* has ${facts.contrarian.count} players nobody else wanted. ` +
        `Either a genius or someone who drafted from memory. History suggests the latter.`
    );
  }
  if (!lines.length) lines.push('Rosters are in. Somehow all of them look like a mistake.');
  return lines.join('\n\n');
}

// Claude-written version of the same roast — the facts are computed here and handed over as
// context, so the model embellishes real draft data rather than inventing players.
async function generateWelcomeRoastWithClaude(facts) {
  if (!ANTHROPIC_API_KEY) return fallbackWelcomeRoast(facts);

  const factLines = [
    `Managers who have drafted: ${facts.managerCount}`,
    `Total picks: ${facts.totalPicks} across ${facts.uniquePlayers} different players`,
    facts.mostRostered.length
      ? `Most-drafted players: ${facts.mostRostered.map((p) => `${p.name}${p.team ? ` (${p.team})` : ''} — taken by ${p.count} managers`).join('; ')}`
      : null,
    facts.biggestStack
      ? `Biggest single-team stack: ${facts.biggestStack.manager} drafted ${facts.biggestStack.count} players from the ${facts.biggestStack.team}`
      : null,
    facts.twins
      ? `Most similar rosters: ${facts.twins.a} and ${facts.twins.b} share ${facts.twins.shared} players (e.g. ${facts.twins.players.join(', ')})`
      : null,
    facts.contrarian
      ? `Most unique picks: ${facts.contrarian.manager}, ${facts.contrarian.count} players nobody else drafted`
      : null,
  ].filter(Boolean);

  const prompt = `You are the trash-talking announcer for the Whit Merrifield Memorial Cup fantasy baseball league. The season starts TODAY and nobody has played a game yet. Write the season-opening post: a savage, funny, profane roast of the DRAFT ITSELF — the herd-mentality picks, the deranged team stacks, the managers who drafted nearly identical rosters.

Roast the league as a whole. Do NOT write a separate roast for every manager, and do not invent players, teams, or statistics — use only the facts below. Naming two or three managers where it lands is good. Keep it to 4-6 sentences.

Draft facts:
${factLines.join('\n')}

Write the roast now. No preamble, no labels — just the roast.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      // Already wrapped in try/catch below, so a throw is handled — but without a deadline a
      // hung connection holds the request open until the platform gives up.
      signal: AbortSignal.timeout(ROAST_API_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error('[Welcome] Anthropic API error:', resp.status, await resp.text().catch(() => ''));
      return fallbackWelcomeRoast(facts);
    }
    const data = await resp.json();
    return (data.content && data.content[0] && data.content[0].text) || fallbackWelcomeRoast(facts);
  } catch (e) {
    console.error('[Welcome] Roast generation failed:', e.message);
    return fallbackWelcomeRoast(facts);
  }
}

// Assemble the message body: header, the roast, then the draft-fact receipts so the numbers
// the roast leans on are visible even if the model got flowery about them.
function buildWelcomeSlackText(facts, roast, year) {
  const receipts = [];
  if (facts.mostRostered.length) {
    receipts.push(`• *Consensus picks:* ${facts.mostRostered.map((p) => `${p.name} (${p.count})`).join(', ')}`);
  }
  if (facts.biggestStack) {
    receipts.push(
      `• *Biggest stack:* ${facts.biggestStack.manager} — ${facts.biggestStack.count} ${facts.biggestStack.team}`
    );
  }
  if (facts.twins) {
    receipts.push(`• *Most alike:* ${facts.twins.a} & ${facts.twins.b} — ${facts.twins.shared} shared players`);
  }
  if (facts.contrarian) {
    receipts.push(`• *Most unique picks:* ${facts.contrarian.manager} — ${facts.contrarian.count}`);
  }
  receipts.push(`• *The field:* ${facts.managerCount} managers, ${facts.uniquePlayers} different players drafted`);

  return [
    `:baseball: *Welcome to the ${year} Whit Merrifield Memorial Cup.* First pitch is today — nobody has scored a point yet, so all we have to go on is your questionable taste in baseball players.`,
    roast.trim(),
    receipts.join('\n'),
    ':link: Full scoreboard: <http://wmmc.live|wmmc.live>',
  ].join('\n\n');
}

async function postSeasonWelcomeSlack(db, year) {
  const sd = (db.seasons || {})[year] || {};
  const facts = buildDraftFacts(db, sd);
  if (!facts) {
    console.log('[Welcome] Skipping — fewer than two managers have submitted a roster yet');
    return false;
  }
  const roast = await generateWelcomeRoastWithClaude(facts);
  await postScoreboardChannelSlack(buildWelcomeSlackText(facts, roast, year));
  return true;
}

// Earliest first pitch (epoch ms) among today's MLB games, or null when the slate is empty.
// `gameDate` is the UTC first-pitch stamp — same field fetchStartedTeamsToday reads.
async function fetchFirstPitchToday(todayISO) {
  const scheduleData = await mlbApiFetch(
    `/api/v1/schedule?sportId=1&startDate=${todayISO}&endDate=${todayISO}&gameType=R,F,D,L,W`
  );
  let earliest = null;
  for (const entry of scheduleData.dates || []) {
    for (const g of entry.games || []) {
      const t = g.gameDate ? Date.parse(g.gameDate) : NaN;
      if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
    }
  }
  return earliest;
}

const WELCOME_LEAD_MS = 60 * 60 * 1000; // land the welcome post an hour before first pitch
const WELCOME_RETRY_MS = 30 * 60 * 1000; // ...and retry this often if rosters aren't in yet

let welcomeTimer = null;

// Send the season-opening post, then claim the day so it can only go out once.
// The claim is written AFTER a successful post, not before (the opposite of the daily
// scoreboard): a welcome post that failed because nobody had drafted yet should be retried,
// not consumed. Retries stay bounded — scheduleSeasonWelcomePost no-ops once the ET date
// rolls past opening day, so a season where nobody ever drafts just goes quiet.
async function fireSeasonWelcomePost(season, todayET) {
  if (readDB().last_welcome_post_date === todayET) return;

  let posted = false;
  try {
    posted = await postSeasonWelcomeSlack(readDB(), season);
  } catch (e) {
    console.error('[Welcome] Post failed:', e.message);
  }

  if (posted) {
    const db = readDB();
    db.last_welcome_post_date = todayET;
    writeDB(db);
    console.log('[Welcome] Season-opening post sent');
  } else {
    console.log(`[Welcome] Nothing posted — retrying in ${WELCOME_RETRY_MS / 60000} minutes`);
    welcomeTimer = setTimeout(() => scheduleSeasonWelcomePost('retry'), WELCOME_RETRY_MS);
  }
}

// Arm the season-opening post for an hour before the day's first pitch.
//
// Safe to call on any day: it no-ops unless today is the season's first day and the post
// hasn't gone out. Called both from the 7am run and at boot, so a restart during the ~6-hour
// gap between 7am and first pitch re-arms the timer rather than silently losing the post.
// If the MLB schedule lookup fails, or the season somehow opens on a day with no games, it
// posts immediately — a welcome post at the wrong hour beats no welcome post at all.
async function scheduleSeasonWelcomePost(reason) {
  const db = readDB();
  const season = (db.google_sheets_config || {}).season || new Date().getFullYear().toString();
  const sd = (db.seasons || {})[season];
  if (!hasScoreboardData(sd)) return;

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (db.last_welcome_post_date === todayET) return;

  const windows = roundDateWindows(sd.schedule_dates || []);
  const seasonStart = windows.reduce((min, w) => (!min || w.start < min ? w.start : min), null);
  if (!seasonStart || todayET !== seasonStart) return;

  let firstPitch = null;
  try {
    firstPitch = await fetchFirstPitchToday(todayET);
    if (firstPitch === null) console.log('[Welcome] No MLB games scheduled today — posting now');
  } catch (e) {
    console.error('[Welcome] First-pitch lookup failed — posting now instead of waiting:', e.message);
  }

  const delay = firstPitch === null ? 0 : Math.max(0, firstPitch - WELCOME_LEAD_MS - Date.now());
  if (welcomeTimer) clearTimeout(welcomeTimer);
  welcomeTimer = setTimeout(() => fireSeasonWelcomePost(season, todayET), delay);
  console.log(
    `[Welcome] Opening day (${reason}) — post armed for ` +
      (delay > 0
        ? `${new Date(Date.now() + delay).toISOString()} (first pitch ${new Date(firstPitch).toISOString()})`
        : 'now')
  );
}

let scoreboardTimer = null;

function scheduleScoreboardPost() {
  if (scoreboardTimer) clearTimeout(scoreboardTimer);

  if (!SLACK_SCOREBOARD_WEBHOOK_URL) {
    console.log(
      '[Scoreboard] SLACK_SCOREBOARD_WEBHOOK_URL not set — auto-post disabled. ' +
        'SLACK_WEBHOOK_URL is NOT a fallback for it: the scoreboard has its own channel, and a ' +
        'process holding only the notifications webhook must not be able to post one.'
    );
    return;
  }

  function runAndReschedule() {
    const now = new Date();
    const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Idempotency guard: claim today's post in db.json (shared across processes/restarts)
    // BEFORE sending to Slack. Render's zero-downtime deploys can briefly run an old and a
    // new instance side by side, and each instance independently arms its own 7am setTimeout
    // — without this guard, both fire and Slack gets two scoreboard posts for the same day
    // (often computed from different in-memory states, e.g. one mid-deploy with no season
    // data loaded yet). Re-reading fresh and writing the claim first keeps the race window
    // as small as possible.
    const db = readDB();
    const config = db.google_sheets_config || {};
    const season = config.season || now.getFullYear().toString();
    const sd = (db.seasons || {})[season];

    if (db.last_scoreboard_post_date === todayET) {
      console.log(`[Scoreboard] Already posted today (${todayET}) — skipping duplicate run`);
    } else if (!hasScoreboardData(sd)) {
      // Checked BEFORE claiming today's date: this process has nothing to report, so it must
      // not consume the day's post slot either. Whichever instance holds the real data still
      // posts. See hasScoreboardData for why this state happens at all.
      console.error(
        `[Scoreboard] Skipping — season ${season} has no usable schedule or scores in this process's ` +
          "db.json, so there is no round to report. Refusing to post the pool-play 'Current Period: " +
          "Season' shell (unrestored/ephemeral instance?)."
      );
    } else {
      db.last_scoreboard_post_date = todayET;
      writeDB(db);

      console.log(`[Scoreboard] 7am run for ${todayET} at ${now.toISOString()}`);
      const plan = scoreboardAutoPostPlan(sd, todayET);

      if (!plan) {
        console.log(
          `[Scoreboard] Skipping — no post scheduled for ${todayET} (between rounds, or playoff round not started)`
        );
      } else if (plan.welcome) {
        // Opening day: no games played, so no scoreboard and no odds compute — just the
        // draft roast, and not now. It lands an hour before first pitch, when people are
        // actually looking, rather than at 7am. Bypasses the sync window too, which only
        // opens the day after the season starts (exactly why day 1 used to be silent).
        scheduleSeasonWelcomePost('7am run').catch((e) => console.error('[Welcome] Scheduling failed:', e.message));
      } else if (plan.summaryRound || isWithinSyncWindow(sd)) {
        // End-of-round recaps bypass the sync window. That window closes the day AFTER the
        // Finals' last day, but a recap posts the MONDAY after a round ends — those coincide
        // only because every round currently ends on a Sunday. Move the Finals' last day to
        // any other weekday and the championship recap would be silently swallowed by a gate
        // about whether STATS should still be synced, not whether a summary should be posted.
        // A recap is only ever produced on the one Monday scoreboardAutoPostPlan names for a
        // round that just ended, so this can't post past the end of the season.
        // Backstop for the 4am compute (e.g. server restarted in between): make
        // sure today's playoff odds exist before posting, then post from a fresh
        // db read so the new odds are included. Odds failures never block the post.
        ensureFreshPlayoffOdds(season, { trigger: '7am-scoreboard' })
          .catch((e) => {
            console.error('[PlayoffOdds] Pre-post odds compute failed (continuing):', e.message);
            return null;
          })
          // Vet the numbers about to be posted against the stats they come from. The post goes out
          // either way (a silent wrong scoreboard is worse than a flagged one) — but the
          // commissioner gets told, instead of finding out hours later from a manager.
          .then(() => alertOnRollupDrift((readDB().seasons || {})[season], season, '7am-scoreboard'))
          .then(() => postScoreboardSlack(readDB(), season, plan))
          .then(() =>
            console.log(
              plan.summaryRound
                ? `[Scoreboard] ${plan.summaryRound} wrap-up scoreboard posted successfully`
                : '[Scoreboard] Daily scoreboard posted successfully'
            )
          )
          .catch((e) => console.error('[Scoreboard] Post failed:', e.message));
      } else {
        console.log(`[Scoreboard] Skipping — outside season date window for ${season}`);
      }
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

  // Re-arm the season-opening post on every boot. Its timer can sit for hours between the
  // 7am run and first pitch, and an in-memory setTimeout does not survive a restart or a
  // deploy — without this, one restart on opening day would lose the post for the season.
  // No-ops on every other day of the year.
  scheduleSeasonWelcomePost('boot').catch((e) => console.error('[Welcome] Boot scheduling failed:', e.message));
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
          if (r.battersAdded > 0 || r.pitchersAdded > 0 || r.changed) {
            console.log(
              `[MLB-API] Pool refresh: +${r.battersAdded} batters, +${r.pitchersAdded} pitchers` +
                (r.changed ? ' (team/id maps updated)' : '')
            );
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
            // Late corrections on weeks that have already closed. The Wednesday catch-up above
            // only reaches the current and prior week, so anything MLB revises after that is
            // invisible without this sweep. Movement beyond the ceiling is refused, not applied —
            // see sweepStatCorrections for why that ceiling exists.
            try {
              const { results: sweep, outcomeChanges } = await sweepStatCorrections(sd, {
                todayISO: todayET,
                db,
              });
              const applied = sweep.filter((r) => r.status === 'applied');
              const flagged = sweep.filter((r) => r.status === 'flagged');
              if (applied.length) {
                addAuditEntry(db, 'mlb_corrections_applied', {
                  year: season,
                  threshold: CORRECTION_MAX_SWING,
                  weeks: applied.map((r) => r.week),
                  outcome_changes: outcomeChanges,
                });
                console.log(
                  `[MLB-API] Late corrections applied to ${applied.length} week(s): ` +
                    applied.map((r) => `${r.week} (max ${r.max_swing})`).join(', ')
                );
              }
              // Only a changed RESULT is worth a Slack post. Corrections that move point totals
              // and nothing else stay in the log — see captureRoundOutcomes for why.
              if (outcomeChanges && outcomeChanges.length) {
                console.warn(`[MLB-API] Corrections changed a round outcome: ${outcomeChanges.join(' | ')}`);
                await postSlack(
                  buildCorrectionOutcomeSlackText(
                    applied.map((r) => r.week),
                    outcomeChanges,
                    (sd.finalized_rounds || []).includes('PP')
                  )
                ).catch(() => {});
              }
              if (flagged.length) {
                // Too big to be a stat correction. A human should look before this is written.
                const detail = flagged
                  .map(
                    (r) =>
                      `${r.week}: ${r.diffs.map((d) => `${d.manager} ${d.diff > 0 ? '+' : ''}${d.diff}`).join(', ')}`
                  )
                  .join(' | ');
                console.warn(`[MLB-API] Corrections sweep REFUSED ${flagged.length} week(s): ${detail}`);
                await postSlack(
                  `:warning: WMMC corrections sweep refused ${flagged.length} week(s) — a re-sync wanted to move ` +
                    `a manager by more than ${CORRECTION_MAX_SWING} pts, which is too large to be a stat correction. ` +
                    `Nothing was written. ${detail}`
                ).catch(() => {});
              }
            } catch (e) {
              console.error('[MLB-API] Corrections sweep failed:', e.message);
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

        // Audit what was just persisted against the stats it was derived from. Runs on a FRESH
        // read for the same reason recordSyncStatus does: after a blocked compile the in-memory sd
        // holds rejected scores, and the numbers that matter are the ones actually on disk — the
        // ones the 7am post will use.
        if (statsCompiled) {
          await alertOnRollupDrift((readDB().seasons || {})[season], season, 'auto-4am');
        }

        // Refresh the playoff odds after the stats settle (no-op outside PP2
        // Week 4–5). Runs on its own fresh read-modify-write AFTER the write
        // above, so a guard-blocked compile still computes odds from the
        // last-good persisted scores rather than the rejected in-memory ones.
        try {
          await ensureFreshPlayoffOdds(season, { force: true, trigger: 'auto-4am' });
        } catch (e) {
          console.error('[PlayoffOdds] 4am odds compute failed (continuing):', e.message);
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
        fs.writeFileSync(DB_FILE, JSON.stringify(saved), 'utf8');
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

    // Memory forensics for the OOM crash loop (exit 134): put db.json size and the V8 heap
    // ceiling side by side in the boot log, so growth toward the limit is visible per deploy.
    try {
      const heapLimitMB = require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024;
      const dbMB = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size / 1024 / 1024 : 0;
      console.log(`[Boot] db.json ${dbMB.toFixed(1)} MB on disk; V8 heap limit ${heapLimitMB.toFixed(0)} MB`);
    } catch (e) {
      console.error('[Boot] size/heap report failed:', e.message);
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

    // Two steps on one db read:
    //  1. STANDING repair — collapse duplicate weekly rows. Cheap (one pass over the weekly
    //     arrays) and still needed every boot: the Sunday auto-advance checks for an existing
    //     row with `b.manager === m.name`, while a duplicate is any second row for the same
    //     round|week|player, so a row already on file under a different manager (or null) can
    //     still produce one — and duplicates double-count in every total.
    //  2. ONE-SHOT — re-derive QS using the WMMC rule and recompute weekly scores. Gated by a
    //     db flag so it runs once, like the purges above.
    try {
      const dbForBackfill = readDB();
      let changed = false;
      for (const sd of Object.values(dbForBackfill.seasons || {})) {
        if (!sd) continue;
        const removed = dedupeWeeklyRows(sd);
        if (removed > 0) {
          changed = true;
          console.log(`[Weekly dedupe] Removed ${removed} duplicate weekly row(s).`);
        }
      }
      if (backfillWmmcQS(dbForBackfill)) changed = true;
      if (changed) writeDB(dbForBackfill);
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
