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
