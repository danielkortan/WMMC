#!/usr/bin/env node
/**
 * Generate tests/fixtures/staging-seed.json — a fully SYNTHETIC WMMC season used
 * to seed the staging environment with fake-but-valid data so the UI renders
 * (standings, rosters, pool-play seeding, playoff bracket).
 *
 * Contains NO real league data: invented managers, invented players, deterministic
 * pseudo-random stats. Safe to commit to a public repo.
 *
 * Deterministic: re-running produces byte-identical output (seeded PRNG), so the
 * committed fixture never churns. Regenerate with:  node scripts/generate-staging-seed.js
 *
 * The shapes here mirror server.js / app.js. SCORING and SEASON_SCHEDULE are copied
 * from server.js and must stay in sync if those constants change.
 */
const fs = require('fs');
const path = require('path');

// --- Constants copied from server.js (keep in sync) ---
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

const SEASON_YEAR = '2026';
const TEAMS = ['LAA', 'NYY', 'LAD', 'MIA', 'NYM', 'HOU', 'ATL', 'SD', 'CHC', 'BOS', 'SEA', 'TEX'];

// Eight invented managers split across two pools. managers[0] is the commissioner
// you log in with: test.commish@example.com + the staging LOGIN_PASSWORD.
const MANAGERS = [
  { name: 'Test Commish', email: 'test.commish@example.com', commissioner: true, pool: 'Pool A', skill: 1.0 },
  { name: 'Alex Angler', email: 'alex.angler@example.com', commissioner: false, pool: 'Pool A', skill: 0.9 },
  { name: 'Blair Bunt', email: 'blair.bunt@example.com', commissioner: false, pool: 'Pool A', skill: 0.8 },
  { name: 'Casey Curve', email: 'casey.curve@example.com', commissioner: false, pool: 'Pool A', skill: 0.7 },
  { name: 'Drew Dinger', email: 'drew.dinger@example.com', commissioner: false, pool: 'Pool B', skill: 0.95 },
  { name: 'Erin Error', email: 'erin.error@example.com', commissioner: false, pool: 'Pool B', skill: 0.85 },
  { name: 'Finn Fastball', email: 'finn.fastball@example.com', commissioner: false, pool: 'Pool B', skill: 0.75 },
  { name: 'Gale Grounder', email: 'gale.grounder@example.com', commissioner: false, pool: 'Pool B', skill: 0.65 },
];

const BATTERS_PER_ROSTER = 5;
const PITCHERS_PER_ROSTER = 3;

// Small deterministic PRNG (mulberry32) so output is stable across runs.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const battingScore = (s) =>
  s['1b'] * SCORING.batting['1B'] +
  s['2b'] * SCORING.batting['2B'] +
  s['3b'] * SCORING.batting['3B'] +
  s.hr * SCORING.batting.HR +
  s.r * SCORING.batting.R +
  s.rbi * SCORING.batting.RBI +
  s.sb * SCORING.batting.SB +
  s.bb * SCORING.batting.BB;

const pitchingScore = (s) =>
  s.w * SCORING.pitching.W +
  s.qs * SCORING.pitching.QS +
  s.cg * SCORING.pitching.CG +
  s.cgso * SCORING.pitching.CGSO +
  s.nh * SCORING.pitching.NH +
  s.ip * SCORING.pitching.IP +
  s.h * SCORING.pitching.H +
  s.er * SCORING.pitching.ER +
  s.bb * SCORING.pitching.BB +
  s.k * SCORING.pitching.K;

const round2 = (x) => Math.round(x * 100) / 100;

// --- Build season ---
const rosters = {};
const battersTeam = {};
const pitchersTeam = {};
const mlbIds = {};
const weeklyBatting = [];
const weeklyPitching = [];
let teamIdx = 0;
let mlbIdSeq = 600000;

MANAGERS.forEach((m, mi) => {
  // Each manager has a fixed set of invented players for the whole season.
  const batters = Array.from({ length: BATTERS_PER_ROSTER }, (_, i) => `${m.name.split(' ')[0]} Batter ${i + 1}`);
  const pitchers = Array.from({ length: PITCHERS_PER_ROSTER }, (_, i) => `${m.name.split(' ')[0]} Pitcher ${i + 1}`);
  [...batters, ...pitchers].forEach((p) => {
    mlbIds[p] = String(mlbIdSeq++);
  });
  batters.forEach((b) => {
    battersTeam[b] = TEAMS[teamIdx++ % TEAMS.length];
  });
  pitchers.forEach((p) => {
    pitchersTeam[p] = TEAMS[teamIdx++ % TEAMS.length];
  });

  rosters[m.name] = {};

  SEASON_SCHEDULE.forEach((sw, idx) => {
    // Only populate pool-play weeks; playoffs left empty (a valid
    // "pool play complete, bracket seeded, playoffs pending" state).
    if (sw.round !== 'PP1' && sw.round !== 'PP2') return;
    const weekKey = `${sw.round}|${sw.week}`;
    rosters[m.name][weekKey] = { batters: [...batters], pitchers: [...pitchers] };

    batters.forEach((batter) => {
      const rng = makeRng(hash(`${m.email}|${weekKey}|${batter}`));
      const f = m.skill; // higher skill -> better stats -> deterministic standings order
      const s = {
        '1b': randInt(rng, 1, Math.round(6 * f)),
        '2b': randInt(rng, 0, Math.round(4 * f)),
        '3b': randInt(rng, 0, 1),
        hr: randInt(rng, 0, Math.round(3 * f)),
        r: randInt(rng, 1, Math.round(8 * f)),
        rbi: randInt(rng, 1, Math.round(8 * f)),
        sb: randInt(rng, 0, 3),
        bb: randInt(rng, 0, 4),
        abs: randInt(rng, 14, 24),
      };
      weeklyBatting.push({
        round: sw.round,
        week: sw.week,
        manager: m.name,
        batter,
        team: battersTeam[batter],
        ...s,
        weekly_score: round2(battingScore(s)),
        total_score: round2(battingScore(s)),
        source: 'mlbapi',
        manual_fields: [],
        drop_locked: false,
      });
    });

    pitchers.forEach((pitcher) => {
      const rng = makeRng(hash(`${m.email}|${weekKey}|${pitcher}`));
      const f = m.skill;
      const ip = round2(randInt(rng, 10, 16) + rng()); // ~10-17 innings across the week
      const s = {
        gs: randInt(rng, 1, 2),
        w: randInt(rng, 0, Math.round(2 * f)),
        qs: randInt(rng, 0, Math.round(2 * f)),
        cg: 0,
        cgso: 0,
        nh: 0,
        ip,
        h: randInt(rng, 4, 12),
        er: randInt(rng, 1, 6),
        bb: randInt(rng, 0, 4),
        k: randInt(rng, 6, Math.round(16 * f)),
      };
      weeklyPitching.push({
        round: sw.round,
        week: sw.week,
        manager: m.name,
        pitcher,
        team: pitchersTeam[pitcher],
        ...s,
        weekly_score: round2(pitchingScore(s)),
        source: 'mlbapi',
      });
    });
  });
});

// 16 weekly date ranges aligned to SEASON_SCHEDULE (only used for drop logic; we
// have no drops, but the array length/start must be present for the scoreboard).
const scheduleDates = [];
let cur = new Date(Date.UTC(2026, 2, 26)); // 2026-03-26
const iso = (d) => d.toISOString().slice(0, 10);
for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
  const start = new Date(cur);
  const end = new Date(cur);
  end.setUTCDate(end.getUTCDate() + 6);
  scheduleDates.push({ start: iso(start), end: iso(end) });
  cur.setUTCDate(cur.getUTCDate() + 7);
}

const db = {
  seasons: {
    // Historical 2025 season. MUST be present: on load the client bootstraps a
    // missing 2025 from data.json and POSTs it (app.js:717) — an auth-required
    // call that 401s before login and triggers a reload loop. Seeding it here
    // (exactly as app.js:714 would build it) prevents that. data.json is already
    // committed to the repo, so this exposes nothing new.
    2025: { status: 'completed', data: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8')) },
    [SEASON_YEAR]: {
      name: `${SEASON_YEAR} WMMC Season (STAGING SAMPLE DATA)`,
      year: SEASON_YEAR,
      status: 'active',
      rosters,
      weekly_batting: weeklyBatting,
      weekly_pitching: weeklyPitching,
      daily_batting: [],
      daily_pitching: [],
      batters_team: battersTeam,
      pitchers_team: pitchersTeam,
      batters_pool: Object.keys(battersTeam),
      pitchers_pool: Object.keys(pitchersTeam),
      swaps: [],
      schedule_dates: scheduleDates,
      roster_dates: {},
      player_dates: {},
      mlb_ids: mlbIds,
      advanced_weeks: [],
      auto_advanced_weeks: [],
    },
  },
  managers: MANAGERS.map(({ name, email, commissioner, pool }) => ({ name, email, commissioner, active: true, pool })),
  audit_log: [],
  google_sheets_config: { enabled: false, season: SEASON_YEAR },
  banner_config: null,
  // Mark all one-time repairs/migrations done so they no-op on staging boot.
  carried_forward_drop_purge_done: true,
  swap_records_repair_done: true,
  roster_chains_repair_done: true,
  roster_chains_repair_v2_done: true,
  mlb_api_takeover_v1: true,
};

const outPath = path.join(__dirname, '..', 'tests', 'fixtures', 'staging-seed.json');
fs.writeFileSync(outPath, JSON.stringify(db, null, 2) + '\n', 'utf8');
console.log(
  `Wrote ${outPath}\n  managers: ${db.managers.length}\n  weekly_batting rows: ${weeklyBatting.length}\n  weekly_pitching rows: ${weeklyPitching.length}`
);
