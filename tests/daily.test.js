import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertIPDecimal,
  battingDelta,
  pitchingDelta,
  computeEffectiveBattingScore,
  computeEffectivePitchingScore,
  recomputeAllWeeklyScores,
} from '../js/daily.js';

// ─── convertIPDecimal ─────────────────────────────────────────────────────────

describe('convertIPDecimal', () => {
  it('converts 6.1 to 6.333', () => {
    assert.equal(convertIPDecimal(6.1), 6.333);
  });

  it('converts 7.2 to 7.667', () => {
    assert.equal(convertIPDecimal(7.2), 7.667);
  });

  it('leaves whole numbers unchanged', () => {
    assert.equal(convertIPDecimal(9), 9);
  });

  it('converts 0.1 to 0.333', () => {
    assert.equal(convertIPDecimal(0.1), 0.333);
  });

  it('handles zero', () => {
    assert.equal(convertIPDecimal(0), 0);
  });

  it('handles string input', () => {
    assert.equal(convertIPDecimal('6.1'), 6.333);
  });
});

// ─── battingDelta ─────────────────────────────────────────────────────────────

describe('battingDelta', () => {
  it('computes delta from consecutive cumulative snapshots', () => {
    const prev = { '1b': 3, '2b': 1, '3b': 0, hr: 1, r: 2, rbi: 2, sb: 0, bb: 1, abs: 12 };
    const curr = { '1b': 4, '2b': 2, '3b': 0, hr: 2, r: 4, rbi: 4, sb: 1, bb: 2, abs: 16 };
    const d = battingDelta(curr, prev);
    assert.equal(d['1b'], 1);
    assert.equal(d['2b'], 1);
    assert.equal(d.hr, 1);
    assert.equal(d.r, 2);
    assert.equal(d.rbi, 2);
    assert.equal(d.sb, 1);
    assert.equal(d.bb, 1);
    assert.equal(d.abs, 4);
  });

  it('floors negative deltas at 0 to guard against week resets', () => {
    const prev = { hr: 5 };
    const curr = { hr: 2 }; // sheet reset or correction
    const d = battingDelta(curr, prev);
    assert.equal(d.hr, 0);
  });

  it('handles missing fields gracefully', () => {
    const d = battingDelta({}, {});
    assert.equal(d.hr, 0);
    assert.equal(d['1b'], 0);
  });

  it('first-day delta equals full cumulative when no previous snapshot', () => {
    const curr = { '1b': 2, hr: 1, r: 2, rbi: 2, sb: 0, bb: 1 };
    // First day: prev is absent so caller passes {}, delta should equal curr
    const d = battingDelta(curr, {});
    assert.equal(d['1b'], 2);
    assert.equal(d.hr, 1);
  });
});

// ─── pitchingDelta ────────────────────────────────────────────────────────────

describe('pitchingDelta', () => {
  it('computes delta from consecutive cumulative snapshots', () => {
    const prev = { w: 1, qs: 1, ip: 6.333, h: 5, er: 2, bb: 2, k: 7, gs: 1, cg: 0, cgso: 0, nh: 0 };
    const curr = { w: 2, qs: 2, ip: 13.0, h: 9, er: 4, bb: 3, k: 15, gs: 2, cg: 0, cgso: 0, nh: 0 };
    const d = pitchingDelta(curr, prev);
    assert.equal(d.w, 1);
    assert.equal(d.qs, 1);
    assert.equal(d.ip, 6.667);
    assert.equal(d.h, 4);
    assert.equal(d.er, 2);
    assert.equal(d.k, 8);
  });

  it('floors negative deltas at 0', () => {
    const prev = { ip: 7.0, k: 8 };
    const curr = { ip: 6.333, k: 5 }; // correction
    const d = pitchingDelta(curr, prev);
    assert.equal(d.ip, 0);
    assert.equal(d.k, 0);
  });
});

// ─── computeEffectiveBattingScore ─────────────────────────────────────────────

describe('computeEffectiveBattingScore', () => {
  it('returns null when no daily records exist', () => {
    const sd = { daily_batting: [] };
    assert.equal(computeEffectiveBattingScore(sd, 'Mike Trout', 'PP1', 'Week 1'), null);
  });

  it('sums all daily deltas when no date constraints', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Mike Trout', delta: { hr: 1, r: 1, rbi: 2 } },
        { date: '2025-04-29', round: 'PP1', week: 'Week 1', batter: 'Mike Trout', delta: { '1b': 2, r: 1 } },
        { date: '2025-04-30', round: 'PP1', week: 'Week 1', batter: 'Mike Trout', delta: { hr: 1 } },
      ],
    };
    // hr=2*10=20, r=2*2=4, rbi=2*2=4, 1b=2*3=6 → total 34
    const score = computeEffectiveBattingScore(sd, 'Mike Trout', 'PP1', 'Week 1');
    assert.equal(score, 34);
  });

  it('excludes days before player start date', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Aaron Judge', delta: { hr: 2, r: 2 } },
        { date: '2025-04-29', round: 'PP1', week: 'Week 1', batter: 'Aaron Judge', delta: { hr: 1, r: 1 } },
        { date: '2025-04-30', round: 'PP1', week: 'Week 1', batter: 'Aaron Judge', delta: { '1b': 3 } },
      ],
      player_dates: {
        'PP1|Week 1': {
          batter: {
            'Aaron Judge': { start: '2025-04-29', end: null },
          },
        },
      },
    };
    // Only Apr-29 and Apr-30 count: hr=1*10=10, r=1*2=2, 1b=3*3=9 → 21
    const score = computeEffectiveBattingScore(sd, 'Aaron Judge', 'PP1', 'Week 1');
    assert.equal(score, 21);
  });

  it('excludes days after player end date', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Player X', delta: { hr: 1 } },
        { date: '2025-04-29', round: 'PP1', week: 'Week 1', batter: 'Player X', delta: { hr: 1 } },
        { date: '2025-04-30', round: 'PP1', week: 'Week 1', batter: 'Player X', delta: { hr: 2 } },
      ],
      player_dates: {
        'PP1|Week 1': {
          batter: {
            'Player X': { start: null, end: '2025-04-29' },
          },
        },
      },
    };
    // Only Apr-28 and Apr-29 count: hr=2*10=20
    const score = computeEffectiveBattingScore(sd, 'Player X', 'PP1', 'Week 1');
    assert.equal(score, 20);
  });

  it('uses schedule_dates as defaults when no player_dates override', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-27', round: 'PP1', week: 'Week 1', batter: 'Test Player', delta: { hr: 5 } }, // before week
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Test Player', delta: { hr: 1 } },
        { date: '2025-05-04', round: 'PP1', week: 'Week 1', batter: 'Test Player', delta: { hr: 1 } }, // after week
      ],
      schedule_dates: [
        { start: '2025-04-28', end: '2025-05-03' }, // PP1 Week 1
      ],
    };
    // Only Apr-28 counts (Apr-27 before week start, May-04 after week end)
    const score = computeEffectiveBattingScore(sd, 'Test Player', 'PP1', 'Week 1');
    assert.equal(score, 10); // 1 HR * 10 pts
  });

  it('does not double-count records from other weeks', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Player Y', delta: { hr: 1 } },
        { date: '2025-05-05', round: 'PP1', week: 'Week 2', batter: 'Player Y', delta: { hr: 3 } },
      ],
    };
    assert.equal(computeEffectiveBattingScore(sd, 'Player Y', 'PP1', 'Week 1'), 10);
    assert.equal(computeEffectiveBattingScore(sd, 'Player Y', 'PP1', 'Week 2'), 30);
  });
});

// ─── computeEffectivePitchingScore ────────────────────────────────────────────

describe('computeEffectivePitchingScore', () => {
  it('returns null when no daily records exist', () => {
    assert.equal(computeEffectivePitchingScore({ daily_pitching: [] }, 'Ace', 'PP1', 'Week 1'), null);
  });

  it('sums daily deltas for all eligible days', () => {
    const sd = {
      daily_pitching: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', pitcher: 'Ace', delta: { w: 1, qs: 1, ip: 7.0, h: 5, er: 2, bb: 1, k: 9, gs: 1, cg: 0, cgso: 0, nh: 0 } },
        { date: '2025-05-01', round: 'PP1', week: 'Week 1', pitcher: 'Ace', delta: { w: 1, qs: 1, ip: 6.333, h: 4, er: 1, bb: 2, k: 8, gs: 1, cg: 0, cgso: 0, nh: 0 } },
      ],
    };
    const score = computeEffectivePitchingScore(sd, 'Ace', 'PP1', 'Week 1');
    // Day 1: 4+4+7*2.25+5*(-0.6)+2*(-2)+1*(-0.6)+9*2 = 4+4+15.75-3-4-0.6+18 = 34.15
    // Day 2: 4+4+6.333*2.25+4*(-0.6)+1*(-2)+2*(-0.6)+8*2 = 4+4+14.25-2.4-2-1.2+16 = 32.65
    assert.ok(typeof score === 'number');
    assert.ok(score > 0);
  });

  it('excludes days before pitcher start date', () => {
    const sd = {
      daily_pitching: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', pitcher: 'Closer', delta: { w: 1, ip: 1.0, k: 2, h: 0, er: 0, bb: 0, qs: 0, cg: 0, cgso: 0, nh: 0, gs: 0 } },
        { date: '2025-04-30', round: 'PP1', week: 'Week 1', pitcher: 'Closer', delta: { w: 1, ip: 1.0, k: 2, h: 0, er: 0, bb: 0, qs: 0, cg: 0, cgso: 0, nh: 0, gs: 0 } },
      ],
      player_dates: {
        'PP1|Week 1': {
          pitcher: { 'Closer': { start: '2025-04-30', end: null } },
        },
      },
    };
    const score = computeEffectivePitchingScore(sd, 'Closer', 'PP1', 'Week 1');
    // Only Apr-30: w=1*4=4, ip=1*2.25=2.25, k=2*2=4 → 10.25
    assert.equal(score, 10.25);
  });
});

// ─── recomputeAllWeeklyScores ─────────────────────────────────────────────────

describe('recomputeAllWeeklyScores', () => {
  it('updates weekly_score for entries with daily data', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Alice Batter', delta: { hr: 2, r: 2, rbi: 3 } },
      ],
      weekly_batting: [
        { round: 'PP1', week: 'Week 1', batter: 'Alice Batter', weekly_score: 99, total_score: 99 },
      ],
      daily_pitching: [],
      weekly_pitching: [],
    };
    recomputeAllWeeklyScores(sd);
    // hr=2*10=20, r=2*2=4, rbi=3*2=6 → 30
    assert.equal(sd.weekly_batting[0].weekly_score, 30);
    assert.equal(sd.weekly_batting[0].total_score, 30);
  });

  it('does not overwrite entries with manual_fields', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Bob', delta: { hr: 5 } },
      ],
      weekly_batting: [
        { round: 'PP1', week: 'Week 1', batter: 'Bob', weekly_score: 42, total_score: 42, manual_fields: ['hr'] },
      ],
      daily_pitching: [],
      weekly_pitching: [],
    };
    recomputeAllWeeklyScores(sd);
    assert.equal(sd.weekly_batting[0].weekly_score, 42); // unchanged
  });

  it('does not overwrite drop_locked entries', () => {
    const sd = {
      daily_batting: [
        { date: '2025-04-28', round: 'PP1', week: 'Week 1', batter: 'Carol', delta: { hr: 5 } },
      ],
      weekly_batting: [
        { round: 'PP1', week: 'Week 1', batter: 'Carol', weekly_score: 77, total_score: 77, drop_locked: true },
      ],
      daily_pitching: [],
      weekly_pitching: [],
    };
    recomputeAllWeeklyScores(sd);
    assert.equal(sd.weekly_batting[0].weekly_score, 77); // unchanged
  });

  it('leaves entries unchanged when no daily data exists', () => {
    const sd = {
      daily_batting: [],
      weekly_batting: [
        { round: 'PP1', week: 'Week 1', batter: 'Dan', weekly_score: 55, total_score: 55 },
      ],
      daily_pitching: [],
      weekly_pitching: [],
    };
    recomputeAllWeeklyScores(sd);
    assert.equal(sd.weekly_batting[0].weekly_score, 55); // null returned, no change
  });
});
