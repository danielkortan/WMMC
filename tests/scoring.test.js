import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORING,
  SEASON_SCHEDULE,
  ROUND_LABELS,
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
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
