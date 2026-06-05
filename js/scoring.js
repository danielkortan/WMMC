// ============================================================
// WMMC — Scoring constants and pure scoring functions
// ============================================================
// These constants and the score calculators are shared between the browser
// (app.js loads them via js/index.js) and the Node test suite. The server
// holds its own copies (server.js) — see README for the "two places that
// must stay in sync" note.

export const SCORING = {
  batting: { '1B': 3, '2B': 5, '3B': 8, HR: 10, R: 2, RBI: 2, SB: 5, BB: 2 },
  pitching: {
    W: 4,
    QS: 4,
    CG: 2.5,
    CGSO: 2.5,
    NH: 5,
    IP: 2.25,
    H: -0.6,
    ER: -2,
    BB: -0.6,
    K: 2,
  },
};

// Each entry represents one scoring week. `label` is the human-readable
// display used in the UI; `round` and `week` are the keys used in db.json.
export const SEASON_SCHEDULE = [
  { round: 'PP1', week: 'Week 1', label: 'Pool Play 1 - Week 1' },
  { round: 'PP1', week: 'Week 2', label: 'Pool Play 1 - Week 2' },
  { round: 'PP1', week: 'Week 3', label: 'Pool Play 1 - Week 3' },
  { round: 'PP1', week: 'Week 4', label: 'Pool Play 1 - Week 4' },
  { round: 'PP1', week: 'Week 5', label: 'Pool Play 1 - Week 5' },
  { round: 'PP2', week: 'Week 1', label: 'Pool Play 2 - Week 1' },
  { round: 'PP2', week: 'Week 2', label: 'Pool Play 2 - Week 2' },
  { round: 'PP2', week: 'Week 3', label: 'Pool Play 2 - Week 3' },
  { round: 'PP2', week: 'Week 4', label: 'Pool Play 2 - Week 4' },
  { round: 'PP2', week: 'Week 5', label: 'Pool Play 2 - Week 5' },
  { round: 'QF', week: 'Week 1', label: 'Quarterfinals - Week 1' },
  { round: 'QF', week: 'Week 2', label: 'Quarterfinals - Week 2' },
  { round: 'SF', week: 'Week 1', label: 'Semifinals - Week 1' },
  { round: 'SF', week: 'Week 2', label: 'Semifinals - Week 2' },
  { round: 'Finals', week: 'Week 1', label: 'Finals / 3rd Place - Week 1' },
  { round: 'Finals', week: 'Week 2', label: 'Finals / 3rd Place - Week 2' },
];

// Map from round key to human-readable label, for legend / breakdown UI.
export const ROUND_LABELS = {
  PP1: 'Pool Play 1',
  PP2: 'Pool Play 2',
  QF: 'Quarterfinals',
  SF: 'Semifinals',
  Finals: 'Finals',
};

// Convert IP from baseball "X.1" / "X.2" notation into a true decimal.
// "6.1" → 6 + 1/3, "7.2" → 7 + 2/3. Identical to server's convertIPDecimal.
export function convertIP(rawIP) {
  const str = String(rawIP);
  const dotIndex = str.indexOf('.');
  if (dotIndex === -1) return parseFloat(rawIP) || 0;
  const whole = parseInt(str.substring(0, dotIndex)) || 0;
  const frac = str.substring(dotIndex + 1);
  if (frac === '1') return Math.round((whole + 1 / 3) * 1000) / 1000;
  if (frac === '2') return Math.round((whole + 2 / 3) * 1000) / 1000;
  return parseFloat(rawIP) || 0;
}

export function calculateBattingScore(stats) {
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

export function calculatePitchingScore(stats) {
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

// The nine scored metrics shown on the Weekly Team Scoring page, grouped into
// three sections. Each section has Batting / Pitching / Total. `weekly` is the
// single-week value; `round` accumulates within a round (resets each round);
// `overall` accumulates across the whole season in schedule order.
export const TEAM_WEEKLY_METRIC_FIELDS = [
  'weekly_batting',
  'weekly_pitching',
  'weekly_total',
  'round_batting',
  'round_pitching',
  'round_total',
  'overall_batting',
  'overall_pitching',
  'overall_total',
];

const round2 = (n) => Math.round(n * 100) / 100;

// Sort a subset of rows by `field` (descending) and stamp a {rank,total} object
// onto each row under row.rank[field][key]. Ties share the field size as total
// but get sequential ranks (stable by input order).
function assignRanks(subset, field, key) {
  const total = subset.length;
  [...subset]
    .sort((a, b) => (b[field] || 0) - (a[field] || 0))
    .forEach((row, i) => {
      row.rank[field][key] = { rank: i + 1, total };
    });
}

// Enrich the base team-weekly rows (which carry only weekly_batting /
// weekly_pitching / weekly_total) with per-round and whole-season cumulative
// totals plus pool and overall ranks for all nine metrics.
//
// Each returned row gains:
//   - round_batting / round_pitching / round_total      (cumulative within round)
//   - overall_batting / overall_pitching / overall_total (cumulative whole season)
//   - rank[field] = { pool: {rank,total}|null, ovr: {rank,total} } for every field
//
// Ranks compare managers sharing the same (round, week): `ovr` against every
// manager active that week, `pool` against managers in the same pool. Mutates
// and returns the same array.
export function enrichTeamWeekly(rows, schedule = SEASON_SCHEDULE) {
  if (!Array.isArray(rows)) return rows;

  // Canonical chronological order for accumulation. We key on the round's
  // position in the schedule plus the numeric week, rather than an exact
  // round|week match, so this also orders legacy historical data whose week
  // numbers run continuously (Week 1..16) with non-schedule round keys (PP2
  // weeks 6-10, QF weeks 11-12, …). For the current schema, week numbers reset
  // per round (Week 1..5), so the round position dominates; for legacy data the
  // globally-unique week number carries the order. Unknown rounds sort first by
  // week number, which is exactly what legacy data needs.
  const roundOrder = {};
  schedule.forEach((s) => {
    if (roundOrder[s.round] === undefined) roundOrder[s.round] = Object.keys(roundOrder).length;
  });
  const weekNum = (w) => {
    const m = /(\d+)/.exec(w || '');
    return m ? parseInt(m[1], 10) : 0;
  };
  const idxOf = (r) => (roundOrder[r.round] === undefined ? 0 : roundOrder[r.round]) * 1000 + weekNum(r.week);

  // --- Cumulative totals (per manager, in schedule order) ---
  const byManager = {};
  rows.forEach((r) => {
    byManager[r.manager] = byManager[r.manager] || [];
    byManager[r.manager].push(r);
  });
  Object.values(byManager).forEach((list) => {
    list.sort((a, b) => idxOf(a) - idxOf(b));
    let seasonBat = 0;
    let seasonPit = 0;
    let curRound = null;
    let roundBat = 0;
    let roundPit = 0;
    list.forEach((r) => {
      if (r.round !== curRound) {
        curRound = r.round;
        roundBat = 0;
        roundPit = 0;
      }
      roundBat += r.weekly_batting || 0;
      roundPit += r.weekly_pitching || 0;
      seasonBat += r.weekly_batting || 0;
      seasonPit += r.weekly_pitching || 0;
      r.round_batting = round2(roundBat);
      r.round_pitching = round2(roundPit);
      r.round_total = round2(roundBat + roundPit);
      r.overall_batting = round2(seasonBat);
      r.overall_pitching = round2(seasonPit);
      r.overall_total = round2(seasonBat + seasonPit);
    });
  });

  // --- Ranks (per round+week cohort, overall and within-pool) ---
  rows.forEach((r) => {
    r.rank = {};
    TEAM_WEEKLY_METRIC_FIELDS.forEach((f) => {
      r.rank[f] = { pool: null, ovr: null };
    });
  });

  const groups = {};
  rows.forEach((r) => {
    const gk = `${r.round}|${r.week}`;
    groups[gk] = groups[gk] || [];
    groups[gk].push(r);
  });

  Object.values(groups).forEach((group) => {
    const byPool = {};
    group.forEach((r) => {
      const p = r.pool || '';
      byPool[p] = byPool[p] || [];
      byPool[p].push(r);
    });
    TEAM_WEEKLY_METRIC_FIELDS.forEach((field) => {
      assignRanks(group, field, 'ovr');
      Object.values(byPool).forEach((sub) => assignRanks(sub, field, 'pool'));
    });
  });

  return rows;
}
