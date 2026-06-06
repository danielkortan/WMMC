import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORING,
  SEASON_SCHEDULE,
  ROUND_LABELS,
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
  enrichTeamWeekly,
  TEAM_WEEKLY_METRIC_FIELDS,
  detectScoreSwings,
} from '../js/scoring.js';

describe('SCORING constants', () => {
  it('exposes the eight batting categories with documented point values', () => {
    assert.deepEqual(SCORING.batting, {
      '1B': 3,
      '2B': 5,
      '3B': 8,
      HR: 10,
      R: 2,
      RBI: 2,
      SB: 5,
      BB: 2,
    });
  });

  it('exposes the ten pitching categories with documented point values', () => {
    assert.deepEqual(SCORING.pitching, {
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
    });
  });
});

describe('SEASON_SCHEDULE', () => {
  it('has 16 scoring weeks across 5 rounds', () => {
    assert.equal(SEASON_SCHEDULE.length, 16);
    const rounds = new Set(SEASON_SCHEDULE.map((s) => s.round));
    assert.deepEqual([...rounds].sort(), ['Finals', 'PP1', 'PP2', 'QF', 'SF']);
  });

  it('has 5 PP1 / 5 PP2 / 2 QF / 2 SF / 2 Finals weeks', () => {
    const counts = SEASON_SCHEDULE.reduce((acc, s) => {
      acc[s.round] = (acc[s.round] || 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(counts, { PP1: 5, PP2: 5, QF: 2, SF: 2, Finals: 2 });
  });
});

describe('ROUND_LABELS', () => {
  it('covers every round used by SEASON_SCHEDULE', () => {
    for (const { round } of SEASON_SCHEDULE) {
      assert.ok(ROUND_LABELS[round], `missing label for ${round}`);
    }
  });
});

describe('convertIP', () => {
  it('returns a whole number unchanged', () => {
    assert.equal(convertIP(6), 6);
    assert.equal(convertIP('7'), 7);
  });

  it('treats X.1 as X + 1/3 with 3-decimal rounding', () => {
    assert.equal(convertIP('6.1'), 6.333);
    assert.equal(convertIP('0.1'), 0.333);
  });

  it('treats X.2 as X + 2/3 with 3-decimal rounding', () => {
    assert.equal(convertIP('7.2'), 7.667);
  });

  it('falls back to parseFloat for unexpected fractional values', () => {
    assert.equal(convertIP('5.5'), 5.5);
  });

  it('returns 0 for non-numeric input', () => {
    assert.equal(convertIP('abc'), 0);
    assert.equal(convertIP(''), 0);
  });
});

describe('calculateBattingScore', () => {
  it('sums each stat times its rubric coefficient', () => {
    // 1×3 + 2×5 + 1×8 + 1×10 + 3×2 + 2×2 + 1×5 + 4×2 = 54
    const stats = { '1b': 1, '2b': 2, '3b': 1, hr: 1, r: 3, rbi: 2, sb: 1, bb: 4 };
    assert.equal(calculateBattingScore(stats), 54);
  });

  it('treats missing stats as 0', () => {
    assert.equal(calculateBattingScore({}), 0);
    assert.equal(calculateBattingScore({ hr: 1 }), 10);
  });

  it('rounds to 2 decimal places', () => {
    // 1.005 × 10 = 10.05 — but float math: 10.05 stays clean here.
    // Construct a deliberate float-trap: 0.1 × 3 = 0.30000000000000004
    assert.equal(calculateBattingScore({ '1b': 0.1 }), 0.3);
  });
});

describe('calculatePitchingScore', () => {
  it('sums each stat times its rubric coefficient', () => {
    // 1×4 + 1×4 + 6×2.25 + 4×−0.6 + 1×−2 + 1×−0.6 + 5×2 = 26.5
    const stats = { w: 1, qs: 1, ip: 6, h: 4, er: 1, bb: 1, k: 5 };
    assert.equal(calculatePitchingScore(stats), 26.5);
  });

  it('treats missing stats as 0', () => {
    assert.equal(calculatePitchingScore({}), 0);
  });

  it('handles negative composites correctly', () => {
    // 10 hits × -0.6 = -6
    assert.equal(calculatePitchingScore({ h: 10 }), -6);
  });
});

describe('enrichTeamWeekly', () => {
  // Build a base team-weekly row (only the three weekly metrics are present
  // before enrichment, mirroring buildTeamWeekly's output in app.js).
  const base = (round, week, manager, pool, bat, pit) => ({
    round,
    week,
    manager,
    pool,
    weekly_batting: bat,
    weekly_pitching: pit,
    weekly_total: Math.round((bat + pit) * 100) / 100,
  });

  const makeRows = () => [
    base('PP1', 'Week 1', 'A', 'Pool 1', 100, 50), // tot 150
    base('PP1', 'Week 1', 'B', 'Pool 1', 90, 40), //  tot 130
    base('PP1', 'Week 1', 'C', 'Pool 2', 120, 35), // tot 155
    base('PP1', 'Week 2', 'A', 'Pool 1', 80, 40), //  tot 120
    base('PP1', 'Week 2', 'B', 'Pool 1', 70, 45), //  tot 115
    base('PP1', 'Week 2', 'C', 'Pool 2', 60, 20), //  tot 80
    base('PP2', 'Week 1', 'A', 'Pool 1', 50, 10), //  tot 60
  ];

  const find = (rows, r, w, m) => rows.find((x) => x.round === r && x.week === w && x.manager === m);

  it('exposes the nine metric field names', () => {
    assert.equal(TEAM_WEEKLY_METRIC_FIELDS.length, 9);
    assert.ok(TEAM_WEEKLY_METRIC_FIELDS.includes('overall_total'));
  });

  it('accumulates per-round totals that reset each round', () => {
    const rows = enrichTeamWeekly(makeRows());
    // PP1 Week 2 for A: round = W1 + W2 of PP1
    const aW2 = find(rows, 'PP1', 'Week 2', 'A');
    assert.equal(aW2.round_batting, 180); // 100 + 80
    assert.equal(aW2.round_pitching, 90); // 50 + 40
    assert.equal(aW2.round_total, 270);
    // PP2 Week 1 for A: round resets to just this week
    const aPP2 = find(rows, 'PP2', 'Week 1', 'A');
    assert.equal(aPP2.round_batting, 50);
    assert.equal(aPP2.round_pitching, 10);
    assert.equal(aPP2.round_total, 60);
  });

  it('accumulates whole-season overall totals across rounds', () => {
    const rows = enrichTeamWeekly(makeRows());
    const aPP2 = find(rows, 'PP2', 'Week 1', 'A');
    assert.equal(aPP2.overall_batting, 230); // 100 + 80 + 50
    assert.equal(aPP2.overall_pitching, 100); // 50 + 40 + 10
    assert.equal(aPP2.overall_total, 330);
  });

  it('ranks weekly totals overall within the same week', () => {
    const rows = enrichTeamWeekly(makeRows());
    // Week 1 totals: C 155 (1st), A 150 (2nd), B 130 (3rd)
    assert.deepEqual(find(rows, 'PP1', 'Week 1', 'C').rank.weekly_total.ovr, { rank: 1, total: 3 });
    assert.deepEqual(find(rows, 'PP1', 'Week 1', 'A').rank.weekly_total.ovr, { rank: 2, total: 3 });
    assert.deepEqual(find(rows, 'PP1', 'Week 1', 'B').rank.weekly_total.ovr, { rank: 3, total: 3 });
  });

  it('ranks weekly totals within pool against only same-pool managers', () => {
    const rows = enrichTeamWeekly(makeRows());
    // Pool 1 in Week 1: A 150 (1/2), B 130 (2/2); Pool 2: C alone (1/1)
    assert.deepEqual(find(rows, 'PP1', 'Week 1', 'A').rank.weekly_total.pool, { rank: 1, total: 2 });
    assert.deepEqual(find(rows, 'PP1', 'Week 1', 'B').rank.weekly_total.pool, { rank: 2, total: 2 });
    assert.deepEqual(find(rows, 'PP1', 'Week 1', 'C').rank.weekly_total.pool, { rank: 1, total: 1 });
  });

  it('ranks a lone manager in a week as 1 of 1', () => {
    const rows = enrichTeamWeekly(makeRows());
    const aPP2 = find(rows, 'PP2', 'Week 1', 'A');
    assert.deepEqual(aPP2.rank.overall_total.ovr, { rank: 1, total: 1 });
    assert.deepEqual(aPP2.rank.overall_total.pool, { rank: 1, total: 1 });
  });

  it('orders legacy continuous week numbers chronologically, independent of input order', () => {
    // Historical seasons number weeks 1..16 continuously across rounds (PP2 weeks
    // 6-10, QF weeks 11-12, …) rather than resetting per round. Accumulation must
    // still follow real chronology no matter what order the rows arrive in.
    const rows = enrichTeamWeekly([
      base('QF', 'Week 11', 'Z', 'QF1', 30, 0),
      base('PP1', 'Week 1', 'Z', 'Pool 1', 10, 0),
      base('PP2', 'Week 6', 'Z', 'Pool 1', 20, 0),
    ]);
    const at = (w) => rows.find((x) => x.week === w);
    assert.equal(at('Week 1').overall_total, 10);
    assert.equal(at('Week 6').overall_total, 30); // 10 + 20
    assert.equal(at('Week 11').overall_total, 60); // 10 + 20 + 30
    // Per-round total resets when the round key changes.
    assert.equal(at('Week 11').round_total, 30);
  });

  it('returns the input array untouched when given a non-array', () => {
    assert.equal(enrichTeamWeekly(null), null);
  });
});

describe('detectScoreSwings', () => {
  it('flags nothing when totals are unchanged', () => {
    const r = detectScoreSwings({ A: 100, B: 200 }, { A: 100, B: 200 });
    assert.equal(r.block, false);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.blockers.length, 0);
    assert.equal(r.maxDrop, 0);
    assert.equal(r.maxGain, 0);
  });

  it('does not flag normal upward movement (up but <=200)', () => {
    const r = detectScoreSwings({ A: 100 }, { A: 250 });
    assert.equal(r.block, false);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.swings[0].delta, 150);
    assert.equal(r.maxGain, 150);
  });

  it('does not flag a small drop under the 40-pt block threshold', () => {
    const r = detectScoreSwings({ A: 100 }, { A: 65 }); // -35
    assert.equal(r.block, false);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.maxDrop, 35);
  });

  it('blocks on a drop of exactly 40 pts', () => {
    const r = detectScoreSwings({ A: 1000 }, { A: 960 });
    assert.equal(r.block, true);
    assert.equal(r.blockers[0].manager, 'A');
    assert.equal(r.maxDrop, 40);
  });

  it('blocks on a large downward swing', () => {
    const r = detectScoreSwings({ A: 1400 }, { A: 1050 });
    assert.equal(r.block, true);
    assert.equal(r.blockers[0].manager, 'A');
    assert.equal(r.maxDrop, 350);
  });

  it('warns (does not block) on an upward jump over 200 pts', () => {
    const r = detectScoreSwings({ A: 1000 }, { A: 1250 }); // +250
    assert.equal(r.block, false);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].manager, 'A');
    assert.equal(r.maxGain, 250);
  });

  it('does not warn on an upward jump of exactly 200 (threshold is strictly greater)', () => {
    const r = detectScoreSwings({ A: 1000 }, { A: 1200 }); // +200
    assert.equal(r.block, false);
    assert.equal(r.warnings.length, 0);
  });

  it('respects custom thresholds', () => {
    const r = detectScoreSwings({ A: 100 }, { A: 80 }, { blockDropPts: 10 }); // -20, block at 10
    assert.equal(r.block, true);
  });

  it('accepts {total} objects as well as plain numbers', () => {
    const r = detectScoreSwings({ A: { total: 1400 } }, { A: { total: 1000 } });
    assert.equal(r.block, true);
    assert.equal(r.swings[0].delta, -400);
  });

  it('sorts swings biggest-drop-first and reports every manager', () => {
    const before = { A: 1400, B: 1150, C: 1100 };
    const after = { A: 1050, B: 1370, C: 1095 }; // A -350, B +220, C -5
    const r = detectScoreSwings(before, after);
    assert.equal(r.swings.length, 3);
    assert.equal(r.swings[0].manager, 'A'); // -350, biggest drop
    assert.equal(r.swings[r.swings.length - 1].manager, 'B'); // +220, biggest gain
    assert.equal(r.block, true); // A dropped 350
    assert.equal(r.warnings.length, 1); // B jumped 220
    assert.equal(r.warnings[0].manager, 'B');
  });
});
