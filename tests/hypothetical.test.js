import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCORING, SEASON_SCHEDULE, calculateBattingScore } from '../js/scoring.js';
import {
  EMPTY_SCENARIO,
  buildScoringTable,
  buildSnapshot,
  isEmptyScenario,
  scoreScenario,
  scoringDiff,
  scoringKeys,
} from '../js/hypothetical.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'staging-seed.json'), 'utf8'));

// Build slots the way app.js does: one per (manager, week, player) with the score the real
// scoring path credited. The fixture's weekly rows carry a `manager` field, which is enough to
// stand in for resolved rosters here — the engine's contract is that slots arrive already
// resolved, so the test supplies them the same way the app does.
function slotsFromFixture(sd) {
  const weekIdxOf = (round, week) => SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
  const slots = [];
  for (const row of sd.weekly_batting || []) {
    if (!row.manager) continue;
    slots.push({
      manager: row.manager,
      round: row.round,
      week: row.week,
      weekIdx: weekIdxOf(row.round, row.week),
      player: row.batter,
      type: 'batting',
      realScore: row.weekly_score || 0,
      addDate: null,
      dropDate: null,
    });
  }
  for (const row of sd.weekly_pitching || []) {
    if (!row.manager) continue;
    slots.push({
      manager: row.manager,
      round: row.round,
      week: row.week,
      weekIdx: weekIdxOf(row.round, row.week),
      player: row.pitcher,
      type: 'pitching',
      realScore: row.weekly_score || 0,
      addDate: null,
      dropDate: null,
    });
  }
  return slots;
}

function fixtureSnapshot() {
  const sd = fixture.seasons['2026'];
  return buildSnapshot({
    slots: slotsFromFixture(sd),
    dailyBatting: sd.daily_batting || [],
    dailyPitching: sd.daily_pitching || [],
    weeklyBatting: sd.weekly_batting || [],
    weeklyPitching: sd.weekly_pitching || [],
    scheduleDates: sd.schedule_dates || [],
    playerDates: sd.player_dates || {},
    managers: Object.keys(sd.rosters || {}),
  });
}

// The single most important property in this module: with nothing overridden, the sandbox must
// reproduce the live standings EXACTLY. If this ever fails, the What If tab is showing managers
// numbers that contradict the real scoreboard.
describe('null-scenario fidelity', () => {
  it('reproduces every real per-manager total exactly under the empty scenario', () => {
    const snapshot = fixtureSnapshot();
    const result = scoreScenario(snapshot, EMPTY_SCENARIO);

    assert.ok(result.standings.length > 0, 'fixture should produce standings');
    for (const s of result.standings) {
      assert.equal(s.hypothetical, s.real, `${s.manager} moved under the empty scenario`);
      assert.equal(s.delta, 0, `${s.manager} has a non-zero delta under the empty scenario`);
    }
  });

  it('matches per-manager totals summed straight from the fixture rows', () => {
    const sd = fixture.seasons['2026'];
    const expected = {};
    for (const row of sd.weekly_batting || []) {
      if (!row.manager) continue;
      expected[row.manager] = (expected[row.manager] || 0) + (row.weekly_score || 0);
    }
    for (const row of sd.weekly_pitching || []) {
      if (!row.manager) continue;
      expected[row.manager] = (expected[row.manager] || 0) + (row.weekly_score || 0);
    }

    const result = scoreScenario(fixtureSnapshot(), EMPTY_SCENARIO);
    for (const s of result.standings) {
      assert.equal(s.real, Math.round((expected[s.manager] || 0) * 100) / 100, `${s.manager} total mismatch`);
    }
  });

  it('reports no rank movement under the empty scenario', () => {
    const result = scoreScenario(fixtureSnapshot(), EMPTY_SCENARIO);
    for (const s of result.standings) assert.equal(s.rankDelta, 0);
  });

  it('treats a scenario dragged back to the real values as the identity', () => {
    const result = scoreScenario(fixtureSnapshot(), { scoring: { batting: { HR: SCORING.batting.HR } } });
    assert.equal(result.identity, true);
    for (const s of result.standings) assert.equal(s.delta, 0);
  });
});

describe('buildScoringTable', () => {
  it('returns the real table when there are no overrides', () => {
    assert.deepEqual(buildScoringTable(null), { batting: { ...SCORING.batting }, pitching: { ...SCORING.pitching } });
  });

  it('never mutates the shared SCORING object', () => {
    const before = JSON.parse(JSON.stringify(SCORING));
    buildScoringTable({ batting: { HR: 99 }, pitching: { K: -5 } });
    assert.deepEqual(JSON.parse(JSON.stringify(SCORING)), before);
  });

  it('merges overrides over the real values and leaves the rest alone', () => {
    const table = buildScoringTable({ batting: { HR: 12 } });
    assert.equal(table.batting.HR, 12);
    assert.equal(table.batting['1B'], SCORING.batting['1B']);
    assert.equal(table.pitching.K, SCORING.pitching.K);
  });

  it('coerces a non-numeric override to zero rather than producing NaN points', () => {
    const table = buildScoringTable({ batting: { HR: '' } });
    assert.equal(table.batting.HR, 0);
  });

  it('accepts a recorded-but-unscored stat as a new scoring key', () => {
    const table = buildScoringTable({ batting: { SO: -1 } });
    assert.equal(table.batting.SO, -1);
    assert.equal(calculateBattingScore({ so: 3 }, table), -3);
  });
});

describe('scoringDiff', () => {
  it('is empty for no overrides', () => {
    assert.deepEqual(scoringDiff(null), []);
    assert.equal(isEmptyScenario(EMPTY_SCENARIO), true);
  });

  it('reports the from/to pair for a changed value', () => {
    assert.deepEqual(scoringDiff({ batting: { HR: 12 } }), [{ side: 'batting', key: 'HR', from: 10, to: 12 }]);
  });

  it('reports adding a previously unscored stat as 0 → value', () => {
    assert.deepEqual(scoringDiff({ batting: { SO: -1 } }), [{ side: 'batting', key: 'SO', from: 0, to: -1 }]);
  });
});

describe('scoreScenario with modified point values', () => {
  it('moves totals when a batting value changes, and leaves pitching untouched', () => {
    const snapshot = fixtureSnapshot();
    const real = scoreScenario(snapshot, EMPTY_SCENARIO);
    const doubled = scoreScenario(snapshot, { scoring: { batting: { HR: 20 } } });

    const realByMgr = new Map(real.standings.map((s) => [s.manager, s]));
    let moved = 0;
    for (const s of doubled.standings) {
      const before = realByMgr.get(s.manager);
      assert.equal(s.real, before.real, 'the real column must never move');
      if (s.delta !== 0) moved++;
      assert.ok(s.delta >= 0, 'raising HR to 20 cannot lower a total');
    }
    assert.ok(moved > 0, 'doubling HR should move at least one manager');
  });

  it('credits exactly the extra points a home run is now worth', () => {
    const sd = fixture.seasons['2026'];
    const snapshot = fixtureSnapshot();
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });

    // +1 point per HR, so each manager's delta is their rostered home run count.
    const hrByMgr = {};
    for (const row of sd.weekly_batting || []) {
      if (!row.manager) continue;
      hrByMgr[row.manager] = (hrByMgr[row.manager] || 0) + (row.hr || 0);
    }
    for (const s of result.standings) {
      assert.equal(s.delta, hrByMgr[s.manager] || 0, `${s.manager} delta should equal their HR count`);
    }
  });

  it('zeroing a category subtracts exactly what that category was worth', () => {
    const sd = fixture.seasons['2026'];
    const result = scoreScenario(fixtureSnapshot(), { scoring: { batting: { SB: 0 } } });
    const sbByMgr = {};
    for (const row of sd.weekly_batting || []) {
      if (!row.manager) continue;
      sbByMgr[row.manager] = (sbByMgr[row.manager] || 0) + (row.sb || 0);
    }
    for (const s of result.standings) {
      assert.equal(s.delta, -(sbByMgr[s.manager] || 0) * SCORING.batting.SB);
    }
  });

  it('can reorder the standings and reports the rank movement', () => {
    const snapshot = fixtureSnapshot();
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 500 }, pitching: { K: 200 } } });
    assert.equal(result.identity, false);
    const sumOfRankDeltas = result.standings.reduce((s, r) => s + r.rankDelta, 0);
    assert.equal(sumOfRankDeltas, 0, 'rank movement must net to zero');
  });

  it('keeps per-period deltas summing to the manager total', () => {
    const result = scoreScenario(fixtureSnapshot(), { scoring: { batting: { HR: 12 } } });
    for (const s of result.standings) {
      const periodSum = Math.round(s.periods.reduce((acc, p) => acc + p.delta, 0) * 100) / 100;
      assert.equal(periodSum, s.delta, `${s.manager} period deltas should sum to the total delta`);
    }
  });

  it('ranks the player table by the size of the swing', () => {
    const result = scoreScenario(fixtureSnapshot(), { scoring: { batting: { HR: 30 } } });
    for (let i = 1; i < result.players.length; i++) {
      assert.ok(Math.abs(result.players[i - 1].delta) >= Math.abs(result.players[i].delta));
    }
  });
});

describe('roster window handling', () => {
  const scheduleDates = [{ start: '2026-03-26', end: '2026-04-01' }];
  const dailyBatting = [
    { batter: 'Window Guy', round: 'PP1', week: 'Week 1', date: '2026-03-27', delta: { hr: 1 } },
    { batter: 'Window Guy', round: 'PP1', week: 'Week 1', date: '2026-03-30', delta: { hr: 1 } },
  ];

  const slot = (extra) => ({
    manager: 'A',
    round: 'PP1',
    week: 'Week 1',
    weekIdx: 0,
    player: 'Window Guy',
    type: 'batting',
    realScore: 20,
    addDate: null,
    dropDate: null,
    ...extra,
  });

  it('counts only games inside the manager add/drop window', () => {
    const snapshot = buildSnapshot({
      slots: [slot({ addDate: '2026-03-29', realScore: 10 })],
      dailyBatting,
      scheduleDates,
      managers: ['A'],
    });
    // One HR inside the window, +1/HR → delta 1, not 2.
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });
    assert.equal(result.standings[0].delta, 1);
    assert.equal(result.fidelity.exact, true);
  });

  it('splits a mid-week handover so each manager gets only their own days', () => {
    const snapshot = buildSnapshot({
      slots: [
        slot({ manager: 'A', dropDate: '2026-03-28', realScore: 10 }),
        slot({ manager: 'B', addDate: '2026-03-29', realScore: 10 }),
      ],
      dailyBatting,
      scheduleDates,
      managers: ['A', 'B'],
    });
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });
    for (const s of result.standings) assert.equal(s.delta, 1, `${s.manager} should get one HR's worth`);
  });

  it('honors a player_dates override in place of the week calendar bound', () => {
    const snapshot = buildSnapshot({
      slots: [slot({ realScore: 10 })],
      dailyBatting,
      scheduleDates,
      playerDates: { 'PP1|Week 1': { batter: { 'Window Guy': { start: '2026-03-29' } } } },
      managers: ['A'],
    });
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });
    assert.equal(result.standings[0].delta, 1);
  });

  it('flags the weekly fallback as approximate for a window-clipped slot', () => {
    const snapshot = buildSnapshot({
      slots: [slot({ addDate: '2026-03-29', realScore: 10 })],
      weeklyBatting: [{ batter: 'Window Guy', round: 'PP1', week: 'Week 1', hr: 2, weekly_score: 20 }],
      scheduleDates,
      managers: ['A'],
    });
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });
    assert.equal(result.fidelity.exact, false);
    assert.equal(result.fidelity.approximateSlots, 1);
    assert.equal(result.standings[0].approximate, 1);
  });

  it('does not flag an unclipped weekly-only slot as approximate', () => {
    const snapshot = buildSnapshot({
      slots: [slot({ realScore: 20 })],
      weeklyBatting: [{ batter: 'Window Guy', round: 'PP1', week: 'Week 1', hr: 2, weekly_score: 20 }],
      scheduleDates,
      managers: ['A'],
    });
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });
    assert.equal(result.fidelity.exact, true);
    assert.equal(result.standings[0].delta, 2);
  });
});

describe('manager list', () => {
  it('includes a manager with no slots at zero rather than dropping them', () => {
    const snapshot = buildSnapshot({ slots: [], managers: ['Empty Guy'] });
    const result = scoreScenario(snapshot, EMPTY_SCENARIO);
    assert.equal(result.standings.length, 1);
    assert.equal(result.standings[0].manager, 'Empty Guy');
    assert.equal(result.standings[0].real, 0);
    assert.equal(result.standings[0].hypothetical, 0);
  });

  it('scores a manual/locked slot by its real score, with the delta from raw stats', () => {
    // A commissioner-entered row whose stored score does not match its raw line: the real column
    // must keep the stored number, and only the delta comes from re-scoring.
    const snapshot = buildSnapshot({
      slots: [
        {
          manager: 'A',
          round: 'PP1',
          week: 'Week 1',
          weekIdx: 0,
          player: 'Manual Guy',
          type: 'batting',
          realScore: 999,
          addDate: null,
          dropDate: null,
        },
      ],
      weeklyBatting: [
        {
          batter: 'Manual Guy',
          round: 'PP1',
          week: 'Week 1',
          hr: 1,
          weekly_score: 999,
          manual_fields: ['weekly_score'],
        },
      ],
      scheduleDates: [{ start: '2026-03-26', end: '2026-04-01' }],
      managers: ['A'],
    });
    const result = scoreScenario(snapshot, { scoring: { batting: { HR: 11 } } });
    assert.equal(result.standings[0].real, 999);
    assert.equal(result.standings[0].delta, 1);
    assert.equal(result.standings[0].hypothetical, 1000);
  });
});

describe('scoringKeys', () => {
  it('lists the real categories as scored', () => {
    const keys = scoringKeys();
    assert.deepEqual(keys.batting.scored, Object.keys(SCORING.batting));
    assert.deepEqual(keys.pitching.scored, Object.keys(SCORING.pitching));
  });

  it('offers only recorded-but-unscored extras', () => {
    const keys = scoringKeys();
    assert.deepEqual(keys.batting.unscored, ['ABS', 'SO', 'LOB']);
    assert.deepEqual(keys.pitching.unscored, ['GS']);
    for (const k of [...keys.batting.unscored, ...keys.pitching.unscored]) {
      assert.ok(!(k in SCORING.batting) && !(k in SCORING.pitching), `${k} must not be a real scoring category`);
    }
  });
});
