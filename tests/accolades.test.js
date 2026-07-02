import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSeasonAccolades } from '../js/accolades.js';

// Helpers to build daily rows. Scores (from SCORING):
//   batting: HR=10, 1B=3, R=2, RBI=2, SB=5, BB=2
//   pitching: IP=2.25, K=2, ER=-2, H=-0.6, BB=-0.6, W=4
const bat = (date, batter, delta, extra = {}) => ({
  date,
  round: 'PP1',
  week: 'Week 1',
  batter,
  delta,
  ...extra,
});
const pit = (date, pitcher, delta, extra = {}) => ({
  date,
  round: 'PP1',
  week: 'Week 1',
  pitcher,
  delta,
  ...extra,
});

// Owner map resolver: every player name is prefixed with its manager ("M1 Bob").
const prefixResolver = (row, type) => {
  const name = type === 'batting' ? row.batter : row.pitcher;
  const m = /^(M\d+)\s/.exec(name);
  return m ? m[1] : null;
};

describe('computeSeasonAccolades', () => {
  it('returns empty tallies for no input', () => {
    const acc = computeSeasonAccolades({});
    assert.equal(acc.days, 0);
    assert.deepEqual(acc.managerBest, []);
    assert.deepEqual(acc.managerWorst, []);
    assert.deepEqual(acc.pitcherNegativeDays, []);
    assert.deepEqual(acc.batterHighKDays, []);
    assert.deepEqual(acc.records, { bestManagerDay: null, worstManagerDay: null, bestPlayerDay: null });
  });

  it('excludes rows the resolver does not attribute (unrostered players)', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [bat('2026-05-01', 'Nobody Jones', { hr: 1 })],
      resolveManager: () => null,
    });
    assert.equal(acc.days, 0);
    assert.equal(acc.records.bestPlayerDay, null);
  });

  it('skips rows whose delta shows no game played', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [
        bat('2026-05-01', 'M1 Idle', { hr: 0, r: 0 }),
        bat('2026-05-01', 'M1 Idle2', null),
        bat('2026-05-01', 'M2 Played', { '1b': 1 }),
      ],
      resolveManager: prefixResolver,
    });
    assert.equal(acc.days, 1);
    assert.deepEqual(
      acc.managerBest.map((m) => m.manager),
      ['M2']
    );
  });

  it('counts daily top-N and bottom-N finishes disjointly across days', () => {
    // 7 managers, one batter each; totals descend M1..M7 on both days.
    const day = (date) => [70, 60, 50, 40, 30, 20, 10].map((r, i) => bat(date, `M${i + 1} Guy`, { r: r / 2 })); // r*2 pts
    const acc = computeSeasonAccolades({
      dailyBatting: [...day('2026-05-01'), ...day('2026-05-02')],
      resolveManager: prefixResolver,
    });
    assert.equal(acc.days, 2);
    assert.deepEqual(acc.managerBest, [
      { manager: 'M1', count: 2 },
      { manager: 'M2', count: 2 },
      { manager: 'M3', count: 2 },
    ]);
    assert.deepEqual(acc.managerWorst, [
      { manager: 'M5', count: 2 },
      { manager: 'M6', count: 2 },
      { manager: 'M7', count: 2 },
    ]);
  });

  it('keeps top/bottom disjoint when fewer than 2*topN managers played (playoff days)', () => {
    // 4 managers: top-3 takes M1-M3, bottom gets only M4.
    const acc = computeSeasonAccolades({
      dailyBatting: [40, 30, 20, 10].map((r, i) => bat('2026-05-01', `M${i + 1} Guy`, { r })),
      resolveManager: prefixResolver,
    });
    assert.deepEqual(acc.managerBest.map((m) => m.manager).sort(), ['M1', 'M2', 'M3']);
    assert.deepEqual(
      acc.managerWorst.map((m) => m.manager),
      ['M4']
    );
  });

  it('a manager whose players were all idle that day is not ranked at all', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [bat('2026-05-01', 'M1 Guy', { hr: 1 }), bat('2026-05-01', 'M2 Idle', { hr: 0 })],
      resolveManager: prefixResolver,
    });
    // Only M1 played; M2 must not appear in either list.
    assert.deepEqual(acc.managerBest, [{ manager: 'M1', count: 1 }]);
    assert.deepEqual(acc.managerWorst, []);
  });

  it('counts pitcher negative days and tracks each pitcher’s worst day', () => {
    const acc = computeSeasonAccolades({
      dailyPitching: [
        // 1 IP (2.25), 5 ER (-10), 3 H (-1.8), 1 BB (-0.6) = -10.15
        pit('2026-05-01', 'M1 Bad Arm', { ip: 1, er: 5, h: 3, bb: 1 }),
        pit('2026-05-03', 'M1 Bad Arm', { ip: 2, er: 3, h: 2 }), // 4.5-6-1.2 = -2.7
        pit('2026-05-03', 'M2 Ace', { ip: 7, k: 9, er: 1 }), // positive day
      ],
      resolveManager: prefixResolver,
    });
    assert.equal(acc.pitcherNegativeDays.length, 1);
    const rec = acc.pitcherNegativeDays[0];
    assert.equal(rec.player, 'M1 Bad Arm');
    assert.equal(rec.manager, 'M1');
    assert.equal(rec.count, 2);
    assert.equal(rec.worst.date, '2026-05-01');
    assert.equal(rec.worst.score, -10.15);
  });

  it('counts batter 3+ strikeout days, aggregating doubleheaders on one date', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [
        // Doubleheader: 2 K + 2 K on the same date = one 4-K day
        bat('2026-05-01', 'M1 Whiffer', { so: 2, abs: 4 }),
        bat('2026-05-01', 'M1 Whiffer', { so: 2, abs: 3 }),
        bat('2026-05-02', 'M1 Whiffer', { so: 3, abs: 4 }),
        bat('2026-05-02', 'M2 Contact', { so: 2, abs: 4 }), // under threshold
      ],
      resolveManager: prefixResolver,
    });
    assert.equal(acc.batterHighKDays.length, 1);
    const rec = acc.batterHighKDays[0];
    assert.equal(rec.player, 'M1 Whiffer');
    assert.equal(rec.count, 2);
    assert.equal(rec.maxK, 4);
    assert.deepEqual(rec.worst, { date: '2026-05-01', so: 4 });
  });

  it('tracks single-day records for managers and players', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [bat('2026-05-01', 'M1 Slugger', { hr: 3, r: 3, rbi: 5 })], // 30+6+10 = 46
      dailyPitching: [
        pit('2026-05-01', 'M2 Meltdown', { ip: 0.333, er: 6, h: 4 }), // ~0.75-12-2.4 = -13.65
        pit('2026-05-02', 'M1 Ace', { ip: 9, k: 12, w: 1 }), // 20.25+24+4 = 48.25
      ],
      resolveManager: prefixResolver,
    });
    assert.deepEqual(acc.records.bestManagerDay, { manager: 'M1', date: '2026-05-02', total: 48.25 });
    assert.equal(acc.records.worstManagerDay.manager, 'M2');
    assert.equal(acc.records.worstManagerDay.date, '2026-05-01');
    assert.deepEqual(acc.records.bestPlayerDay, {
      player: 'M1 Ace',
      type: 'Pitcher',
      manager: 'M1',
      date: '2026-05-02',
      score: 48.25,
    });
  });

  it('sorts leaderboards by count, with sensible tiebreaks', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [
        bat('2026-05-01', 'M1 A', { so: 3, abs: 4 }),
        bat('2026-05-01', 'M2 B', { so: 4, abs: 4 }),
        bat('2026-05-01', 'M1 A2', { hr: 1 }),
      ],
      resolveManager: prefixResolver,
    });
    // Same count (1 each) — higher maxK sorts first.
    assert.deepEqual(
      acc.batterHighKDays.map((r) => r.player),
      ['M2 B', 'M1 A']
    );
  });

  it('honors custom topN and minStrikeouts options', () => {
    const acc = computeSeasonAccolades({
      dailyBatting: [
        bat('2026-05-01', 'M1 Guy', { r: 5 }),
        bat('2026-05-01', 'M2 Guy', { r: 3 }),
        bat('2026-05-01', 'M3 Guy', { so: 2, abs: 4, bb: 1 }),
      ],
      resolveManager: prefixResolver,
      topN: 1,
      minStrikeouts: 2,
    });
    assert.deepEqual(acc.managerBest, [{ manager: 'M1', count: 1 }]);
    assert.deepEqual(acc.managerWorst, [{ manager: 'M3', count: 1 }]);
    assert.equal(acc.batterHighKDays.length, 1);
    assert.equal(acc.batterHighKDays[0].player, 'M3 Guy');
  });
});
