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
  realRosterForRound,
  rosterOverrides,
  roundsPlayed,
  scoreScenario,
  scoringDiff,
  scoringKeys,
  weeksInRound,
  lastKnownRoster,
  scoreRosterForRound,
  roundHasStats,
  statCoverage,
  scenarioStatCoverage,
  topPlayers,
  playerSuggestions,
  playerTypes,
  playerOwnership,
  playerGameLog,
  playerRoundTotals,
  explainPlayer,
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

// ============================================================
// Roster Lab — replacing a period's roster, and building one for a round never played
// ============================================================

const ROSTER_SCHEDULE = [
  { round: 'PP1', week: 'Week 1' },
  { round: 'PP1', week: 'Week 2' },
  { round: 'SF', week: 'Week 1' },
  { round: 'SF', week: 'Week 2' },
];
const ROSTER_DATES = [
  { start: '2026-03-26', end: '2026-04-01' },
  { start: '2026-04-02', end: '2026-04-08' },
  { start: '2026-04-09', end: '2026-04-15' },
  { start: '2026-04-16', end: '2026-04-22' },
];

// Weekly rows for everyone, so a swapped-in or newly entered player has stats to score.
const ROSTER_WEEKLY_BAT = [
  { batter: 'Starter', round: 'PP1', week: 'Week 1', hr: 1, weekly_score: 10 },
  { batter: 'Starter', round: 'PP1', week: 'Week 2', hr: 1, weekly_score: 10 },
  { batter: 'Bench', round: 'PP1', week: 'Week 1', hr: 3, weekly_score: 30 },
  { batter: 'Bench', round: 'PP1', week: 'Week 2', hr: 3, weekly_score: 30 },
  { batter: 'SF Guy', round: 'SF', week: 'Week 1', hr: 2, weekly_score: 20 },
  { batter: 'SF Guy', round: 'SF', week: 'Week 2', hr: 4, weekly_score: 40 },
];

function rosterSlot(manager, round, week, weekIdx, player, realScore) {
  return { manager, round, week, weekIdx, player, type: 'batting', realScore, addDate: null, dropDate: null };
}

// "A" really rostered Starter through PP1 and was eliminated before the SF.
function rosterSnapshot() {
  return buildSnapshot({
    slots: [rosterSlot('A', 'PP1', 'Week 1', 0, 'Starter', 10), rosterSlot('A', 'PP1', 'Week 2', 1, 'Starter', 10)],
    weeklyBatting: ROSTER_WEEKLY_BAT,
    scheduleDates: ROSTER_DATES,
    schedule: ROSTER_SCHEDULE,
    managers: ['A'],
  });
}

describe('roster overrides', () => {
  it('is not the identity once a roster is overridden, even with real scoring', () => {
    const scenario = { rosters: { A: { PP1: { batters: ['Bench'], pitchers: [] } } } };
    assert.equal(isEmptyScenario(scenario), false);
    assert.equal(rosterOverrides(scenario).length, 1);
  });

  it('swaps a player for the whole period and scores the replacement', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { PP1: { batters: ['Bench'], pitchers: [] } } },
    });
    const a = result.standings[0];
    assert.equal(a.real, 20, 'the real column must not move');
    assert.equal(a.hypothetical, 60, 'Bench scored 30 in each of the two PP1 weeks');
    assert.equal(a.delta, 40);
  });

  it('leaves the real column alone even when the whole roster is emptied', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { PP1: { batters: [], pitchers: [] } } },
    });
    assert.equal(result.standings[0].real, 20);
    assert.equal(result.standings[0].hypothetical, 0);
    assert.equal(result.standings[0].delta, -20);
  });

  it('marks a dropped player benched and a new player added', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { PP1: { batters: ['Bench'], pitchers: [] } } },
    });
    const starter = result.players.find((p) => p.player === 'Starter');
    const bench = result.players.find((p) => p.player === 'Bench');
    assert.equal(starter.benched, true);
    assert.equal(starter.real, 20);
    assert.equal(starter.hypothetical, 0);
    assert.equal(bench.added, true);
    assert.equal(bench.real, 0);
    assert.equal(bench.hypothetical, 60);
    assert.equal(result.rosterChanges.benched, 2, 'one benched slot per week');
    assert.equal(result.rosterChanges.added, 1);
  });

  it('keeping the real roster explicitly changes nothing but the identity flag', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { PP1: { batters: ['Starter'], pitchers: [] } } },
    });
    assert.equal(result.standings[0].real, 20);
    assert.equal(result.standings[0].hypothetical, 20);
    assert.equal(result.standings[0].delta, 0);
    assert.equal(result.rosterChanges.benched, 0);
    assert.equal(result.rosterChanges.added, 0);
  });

  it('does not touch a period that was not overridden', () => {
    const snapshot = buildSnapshot({
      slots: [rosterSlot('A', 'PP1', 'Week 1', 0, 'Starter', 10), rosterSlot('A', 'SF', 'Week 1', 2, 'SF Guy', 20)],
      weeklyBatting: ROSTER_WEEKLY_BAT,
      scheduleDates: ROSTER_DATES,
      schedule: ROSTER_SCHEDULE,
      managers: ['A'],
    });
    const result = scoreScenario(snapshot, { rosters: { A: { PP1: { batters: [], pitchers: [] } } } });
    const sf = result.standings[0].periods.find((p) => p.round === 'SF');
    assert.equal(sf.real, 20);
    assert.equal(sf.hypothetical, 20, 'the untouched SF period keeps its real score');
  });

  it('combines a roster override with a scoring change', () => {
    const result = scoreScenario(rosterSnapshot(), {
      scoring: { batting: { HR: 20 } },
      rosters: { A: { PP1: { batters: ['Bench'], pitchers: [] } } },
    });
    // Bench: 3 HR per week at 20 pts = 60/week over two weeks.
    assert.equal(result.standings[0].hypothetical, 120);
  });
});

describe('counterfactual rounds', () => {
  it('knows which rounds a manager actually played', () => {
    const played = roundsPlayed(rosterSnapshot(), 'A');
    assert.equal(played.has('PP1'), true);
    assert.equal(played.has('SF'), false);
  });

  it('reports the real roster for a period as the lab starting point', () => {
    assert.deepEqual(realRosterForRound(rosterSnapshot(), 'A', 'PP1'), {
      batters: ['Starter'],
      pitchers: [],
    });
    assert.deepEqual(realRosterForRound(rosterSnapshot(), 'A', 'SF'), { batters: [], pitchers: [] });
  });

  it('scores a roster entered for a round the manager never reached', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { SF: { batters: ['SF Guy'], pitchers: [] } } },
    });
    const a = result.standings[0];
    assert.equal(a.real, 20, 'a round never played adds nothing to the real total');
    // SF Guy really scored 20 then 40 across the two SF weeks.
    assert.equal(a.hypothetical, 80);
    const sf = a.periods.find((p) => p.round === 'SF');
    assert.equal(sf.real, 0);
    assert.equal(sf.hypothetical, 60);
  });

  it('counts every counterfactual slot as synthetic so the UI can label it', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { SF: { batters: ['SF Guy'], pitchers: [] } } },
    });
    assert.equal(result.fidelity.syntheticSlots, 2, 'one per SF week');
    assert.equal(result.players.find((p) => p.player === 'SF Guy').added, true);
  });

  it('scores an entered player with no stats that round as zero, not an error', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { SF: { batters: ['Nobody At All'], pitchers: [] } } },
    });
    assert.equal(result.standings[0].hypothetical, 20);
    assert.equal(result.fidelity.exact, true);
  });

  it('lists the weeks of a round for building a counterfactual roster', () => {
    assert.deepEqual(weeksInRound(rosterSnapshot(), 'SF'), [
      { week: 'Week 1', weekIdx: 2 },
      { week: 'Week 2', weekIdx: 3 },
    ]);
  });
});

describe('playoff picture', () => {
  // Two managers in one pool. B really outscores A in both periods and takes the pool.
  const poolSnapshot = () =>
    buildSnapshot({
      slots: [rosterSlot('A', 'PP1', 'Week 1', 0, 'Starter', 10), rosterSlot('B', 'PP1', 'Week 1', 0, 'Bench', 30)],
      weeklyBatting: ROSTER_WEEKLY_BAT,
      scheduleDates: ROSTER_DATES,
      schedule: ROSTER_SCHEDULE,
      managers: ['A', 'B'],
      pools: { A: 'Pool A', B: 'Pool A' },
    });

  it('reports the real qualifiers under the empty scenario and no change', () => {
    const result = scoreScenario(poolSnapshot(), EMPTY_SCENARIO);
    assert.deepEqual(result.playoffs.real, result.playoffs.hypothetical);
    assert.equal(result.playoffs.changed, false);
    assert.deepEqual(result.playoffs.in, []);
    assert.deepEqual(result.playoffs.out, []);
  });

  it('flips the pool winner when a roster change overtakes the leader', () => {
    const result = scoreScenario(poolSnapshot(), {
      // A starts Bench (30/wk) instead of Starter (10/wk), overtaking B.
      rosters: { A: { PP1: { batters: ['Bench'], pitchers: [] } } },
    });
    assert.equal(result.playoffs.hypothetical[0], 'A', 'A should now lead the pool');
    assert.equal(result.playoffs.changed, true);
  });

  it('omits managers with no pool from the playoff picture', () => {
    const snapshot = buildSnapshot({
      slots: [rosterSlot('A', 'PP1', 'Week 1', 0, 'Starter', 10)],
      weeklyBatting: ROSTER_WEEKLY_BAT,
      scheduleDates: ROSTER_DATES,
      schedule: ROSTER_SCHEDULE,
      managers: ['A'],
      pools: {},
    });
    assert.equal(scoreScenario(snapshot, EMPTY_SCENARIO).playoffs, null);
  });
});

describe('per-round player breakdown (the side-by-side view)', () => {
  const find = (rows, player) => rows.find((p) => p.player === player);

  it('pairs each real player with what they would score under the scenario', () => {
    const result = scoreScenario(rosterSnapshot(), { scoring: { batting: { HR: 20 } } });
    const rows = result.playerRounds.filter((p) => p.manager === 'A' && p.round === 'PP1');
    const starter = find(rows, 'Starter');
    assert.equal(starter.real, 20, 'really scored 10 in each of two weeks');
    assert.equal(starter.hypothetical, 40, 'at 20 pts a HR that doubles');
    assert.equal(starter.delta, 20);
  });

  it('keeps a benched player visible with his real points and zero hypothetical', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { PP1: { batters: ['Bench'], pitchers: [] } } },
    });
    const rows = result.playerRounds.filter((p) => p.manager === 'A' && p.round === 'PP1');
    const starter = find(rows, 'Starter');
    assert.equal(starter.benched, true);
    assert.equal(starter.real, 20, 'what he really scored stays on the actual side');
    assert.equal(starter.hypothetical, 0);
    const bench = find(rows, 'Bench');
    assert.equal(bench.added, true);
    assert.equal(bench.real, 0, 'he was never really rostered, so the actual side is empty');
    assert.equal(bench.hypothetical, 60);
  });

  it('scopes to the round, so one period does not borrow another period points', () => {
    const snapshot = buildSnapshot({
      slots: [rosterSlot('A', 'PP1', 'Week 1', 0, 'Starter', 10), rosterSlot('A', 'SF', 'Week 1', 2, 'Starter', 99)],
      weeklyBatting: ROSTER_WEEKLY_BAT,
      scheduleDates: ROSTER_DATES,
      schedule: ROSTER_SCHEDULE,
      managers: ['A'],
    });
    const rows = scoreScenario(snapshot, EMPTY_SCENARIO).playerRounds.filter((p) => p.player === 'Starter');
    assert.equal(
      find(
        rows.filter((r) => r.round === 'PP1'),
        'Starter'
      ).real,
      10
    );
    assert.equal(
      find(
        rows.filter((r) => r.round === 'SF'),
        'Starter'
      ).real,
      99
    );
  });

  it('shows a counterfactual round with an empty actual side', () => {
    const result = scoreScenario(rosterSnapshot(), {
      rosters: { A: { SF: { batters: ['SF Guy'], pitchers: [] } } },
    });
    const rows = result.playerRounds.filter((p) => p.manager === 'A' && p.round === 'SF');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].real, 0, 'nothing was actually rostered in a round never played');
    assert.equal(rows[0].hypothetical, 60);
    assert.equal(rows[0].added, true);
  });

  it('sums the per-round rows back to the period total', () => {
    const result = scoreScenario(rosterSnapshot(), { scoring: { batting: { HR: 20 } } });
    const rows = result.playerRounds.filter((p) => p.manager === 'A' && p.round === 'PP1');
    const period = result.standings[0].periods.find((p) => p.round === 'PP1');
    const sumReal = rows.reduce((s, r) => s + r.real, 0);
    const sumHypo = rows.reduce((s, r) => s + r.hypothetical, 0);
    assert.equal(sumReal, period.real);
    assert.equal(sumHypo, period.hypothetical);
  });
});

// ============================================================
// Player Explorer — look up any player, rostered or not
// ============================================================

const EXPLORER_DAILY_BAT = [
  { batter: 'Star Guy', round: 'PP1', week: 'Week 1', date: '2026-03-27', delta: { hr: 1, r: 1 } },
  { batter: 'Star Guy', round: 'PP1', week: 'Week 1', date: '2026-03-29', delta: { hr: 2, rbi: 3 } },
  { batter: 'Star Guy', round: 'PP1', week: 'Week 2', date: '2026-04-03', delta: { '1b': 2 } },
  { batter: 'Free Agent', round: 'PP1', week: 'Week 1', date: '2026-03-28', delta: { hr: 5 } },
];
const EXPLORER_WEEKLY_BAT = [
  { batter: 'Star Guy', round: 'PP1', week: 'Week 1', hr: 3, r: 1, rbi: 3, weekly_score: 38 },
  { batter: 'Star Guy', round: 'PP1', week: 'Week 2', '1b': 2, weekly_score: 6 },
  { batter: 'Star Guy', round: 'SF', week: 'Week 1', hr: 1, weekly_score: 10 },
  { batter: 'Free Agent', round: 'PP1', week: 'Week 1', hr: 5, weekly_score: 50 },
];
const EXPLORER_WEEKLY_PIT = [{ pitcher: 'Some Arm', round: 'PP1', week: 'Week 1', k: 10, ip: 6, weekly_score: 33.5 }];

function explorerSnapshot({ withDaily = true } = {}) {
  return buildSnapshot({
    // Only Star Guy was ever rostered, and only for PP1 Week 1.
    slots: [rosterSlot('A', 'PP1', 'Week 1', 0, 'Star Guy', 38)],
    dailyBatting: withDaily ? EXPLORER_DAILY_BAT : [],
    weeklyBatting: EXPLORER_WEEKLY_BAT,
    weeklyPitching: EXPLORER_WEEKLY_PIT,
    scheduleDates: ROSTER_DATES,
    schedule: ROSTER_SCHEDULE,
    managers: ['A'],
  });
}

describe('playerTypes', () => {
  it('reports which side of the ball a player has rows for', () => {
    assert.deepEqual(playerTypes(explorerSnapshot(), 'Star Guy'), ['batting']);
    assert.deepEqual(playerTypes(explorerSnapshot(), 'Some Arm'), ['pitching']);
    assert.deepEqual(playerTypes(explorerSnapshot(), 'Nobody'), []);
  });
});

describe('playerOwnership', () => {
  it('reports who rostered a player and what they were credited', () => {
    const owners = playerOwnership(explorerSnapshot(), 'Star Guy', 'batting');
    assert.equal(owners.length, 1);
    assert.equal(owners[0].manager, 'A');
    assert.deepEqual(owners[0].rounds, ['PP1']);
    assert.equal(owners[0].real, 38);
  });

  it('returns nobody for a player no manager ever rostered', () => {
    assert.deepEqual(playerOwnership(explorerSnapshot(), 'Free Agent', 'batting'), []);
  });
});

describe('playerGameLog', () => {
  it('returns one row per game, scored both ways, in date order', () => {
    const log = playerGameLog(explorerSnapshot(), 'Star Guy', 'batting', { scoring: { batting: { HR: 20 } } });
    assert.deepEqual(
      log.map((r) => r.date),
      ['2026-03-27', '2026-03-29', '2026-04-03']
    );
    assert.equal(log[0].real, 12, '1 HR (10) + 1 R (2)');
    assert.equal(log[0].hypothetical, 22, 'HR now worth 20');
    assert.equal(log[0].delta, 10);
  });

  it('covers a player nobody rostered', () => {
    const log = playerGameLog(explorerSnapshot(), 'Free Agent', 'batting');
    assert.equal(log.length, 1);
    assert.equal(log[0].real, 50);
  });

  it('is empty when daily rows have not loaded', () => {
    assert.deepEqual(playerGameLog(explorerSnapshot({ withDaily: false }), 'Star Guy', 'batting'), []);
  });
});

describe('playerRoundTotals', () => {
  it('totals a player by round, scored both ways, in schedule order', () => {
    const rounds = playerRoundTotals(explorerSnapshot(), 'Star Guy', 'batting', {
      scoring: { batting: { HR: 20 } },
    });
    assert.deepEqual(
      rounds.map((r) => r.round),
      ['PP1', 'SF']
    );
    assert.equal(rounds[0].real, 44, 'week1 38 + week2 6');
    assert.equal(rounds[0].hypothetical, 74, 'three PP1 home runs gain 10 each');
    assert.equal(rounds[0].delta, 30);
  });

  it('separates what a player was worth from what a manager was credited', () => {
    const rounds = playerRoundTotals(explorerSnapshot(), 'Star Guy', 'batting');
    const pp1 = rounds.find((r) => r.round === 'PP1');
    assert.equal(pp1.real, 44, 'he was worth 44 across both PP1 weeks');
    assert.equal(pp1.credited, 38, 'but only Week 1 was ever rostered');
    const sf = rounds.find((r) => r.round === 'SF');
    assert.equal(sf.credited, 0, 'nobody held him in the SF');
  });

  it('reports a free agent worth points that nobody was credited', () => {
    const rounds = playerRoundTotals(explorerSnapshot(), 'Free Agent', 'batting');
    assert.equal(rounds[0].real, 50);
    assert.equal(rounds[0].credited, 0);
  });
});

describe('playerRoundTotals anchoring', () => {
  // A commissioner-adjusted row: its stored score deliberately does not match its raw line.
  const anchored = () =>
    buildSnapshot({
      slots: [],
      weeklyBatting: [{ batter: 'Adjusted', round: 'PP1', week: 'Week 1', hr: 1, weekly_score: 99 }],
      scheduleDates: ROSTER_DATES,
      schedule: ROSTER_SCHEDULE,
      managers: [],
    });

  it('reports the STORED score, not a recomputation of the raw line', () => {
    const rounds = playerRoundTotals(anchored(), 'Adjusted', 'batting');
    assert.equal(rounds[0].real, 99, 'the stored score is authoritative');
  });

  it('applies a scoring change as a delta on top of the stored score', () => {
    const rounds = playerRoundTotals(anchored(), 'Adjusted', 'batting', { scoring: { batting: { HR: 20 } } });
    assert.equal(rounds[0].hypothetical, 109, '99 + the extra 10 the one HR is now worth');
    assert.equal(rounds[0].delta, 10);
  });
});

describe('explainPlayer', () => {
  it('bundles rounds, log, owners and totals', () => {
    const info = explainPlayer(explorerSnapshot(), 'Star Guy', 'batting', { scoring: { batting: { HR: 20 } } });
    assert.equal(info.player, 'Star Guy');
    assert.equal(info.hasGameLog, true);
    assert.equal(info.owners.length, 1);
    assert.equal(info.total.real, 54, '44 in PP1 + 10 in the SF');
    assert.equal(info.total.hypothetical, 94);
    assert.equal(info.total.delta, 40);
    assert.equal(info.total.credited, 38);
  });

  it('reports no game log when daily rows are absent, keeping round totals', () => {
    const info = explainPlayer(explorerSnapshot({ withDaily: false }), 'Star Guy', 'batting');
    assert.equal(info.hasGameLog, false);
    assert.equal(info.rounds.length, 2);
    assert.equal(info.total.real, 54);
  });

  it('returns an empty but valid shape for an unknown player', () => {
    const info = explainPlayer(explorerSnapshot(), 'Nobody At All', 'batting');
    assert.deepEqual(info.rounds, []);
    assert.deepEqual(info.owners, []);
    assert.equal(info.total.real, 0);
    assert.equal(info.total.delta, 0);
  });

  it('leaves totals unmoved under the empty scenario', () => {
    const info = explainPlayer(explorerSnapshot(), 'Star Guy', 'batting', EMPTY_SCENARIO);
    assert.equal(info.total.hypothetical, info.total.real);
    assert.equal(info.total.delta, 0);
    for (const r of info.rounds) assert.equal(r.delta, 0);
  });
});

describe('search suggestions ranked by points', () => {
  const ranked = () =>
    buildSnapshot({
      weeklyBatting: [
        { batter: 'Superstar', round: 'PP1', week: 'Week 1', weekly_score: 500 },
        { batter: 'Superstar', round: 'SF', week: 'Week 1', weekly_score: 100 },
        { batter: 'Solid Guy', round: 'PP1', week: 'Week 1', weekly_score: 200 },
        { batter: 'Scrub', round: 'PP1', week: 'Week 1', weekly_score: 5 },
        { batter: 'Sofa King', round: 'SF', week: 'Week 1', weekly_score: 400 },
      ],
      schedule: ROSTER_SCHEDULE,
    });

  it('offers the highest scorers first when nothing is typed', () => {
    assert.deepEqual(
      topPlayers(ranked(), { type: 'batting' }).map((p) => p.name),
      ['Superstar', 'Sofa King', 'Solid Guy', 'Scrub']
    );
  });

  it('reports each suggestion with its point total', () => {
    const top = topPlayers(ranked(), { type: 'batting', limit: 1 });
    assert.deepEqual(top, [{ name: 'Superstar', points: 600 }]);
  });

  it('caps the list at the requested limit', () => {
    assert.equal(topPlayers(ranked(), { type: 'batting', limit: 2 }).length, 2);
    assert.equal(playerSuggestions(ranked(), { type: 'batting', limit: 2 }).length, 2);
  });

  it('scopes the ranking to one round when asked', () => {
    assert.deepEqual(
      topPlayers(ranked(), { type: 'batting', round: 'SF' }).map((p) => p.name),
      ['Sofa King', 'Superstar']
    );
  });

  it('defaults to the top scorers with an empty query', () => {
    assert.deepEqual(
      playerSuggestions(ranked(), { type: 'batting' }).map((p) => p.name),
      ['Superstar', 'Sofa King', 'Solid Guy', 'Scrub']
    );
  });

  it('searches the full league once a query is typed, not just the top scorers', () => {
    const names = playerSuggestions(ranked(), { type: 'batting', query: 'scrub' }).map((p) => p.name);
    assert.deepEqual(names, ['Scrub'], 'a low scorer is still reachable by name');
  });

  it('ranks prefix matches first, then by points', () => {
    const names = playerSuggestions(ranked(), { type: 'batting', query: 'so' }).map((p) => p.name);
    // All four start with S; "so" prefixes Sofa King and Solid Guy, and Sofa King outscores him.
    assert.deepEqual(names.slice(0, 2), ['Sofa King', 'Solid Guy']);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(
      playerSuggestions(ranked(), { type: 'batting', query: 'SUPERSTAR' }).map((p) => p.name),
      ['Superstar']
    );
  });

  it('returns nothing for a round with no stats', () => {
    assert.deepEqual(topPlayers(ranked(), { type: 'batting', round: 'Finals' }), []);
  });

  it('returns nothing for a query that matches nobody', () => {
    assert.deepEqual(playerSuggestions(ranked(), { type: 'batting', query: 'zzz' }), []);
  });
});

describe('carried-forward rosters', () => {
  // "A" played PP1 only; "B" played PP1 and SF. Weeks: PP1 w1/w2, SF w1/w2.
  // Own stat rows: 'Starter' has to have SEMIFINAL numbers for a carried roster to be worth
  // anything there, and ROSTER_WEEKLY_BAT deliberately gives him none.
  const CARRY_WEEKLY = [
    ...ROSTER_WEEKLY_BAT,
    { batter: 'Starter', round: 'SF', week: 'Week 1', hr: 1, weekly_score: 10 },
    { batter: 'Bench', round: 'SF', week: 'Week 1', hr: 5, weekly_score: 50 },
  ];

  const carrySnapshot = () =>
    buildSnapshot({
      slots: [
        rosterSlot('A', 'PP1', 'Week 1', 0, 'Starter', 10),
        rosterSlot('A', 'PP1', 'Week 2', 1, 'Starter', 10),
        rosterSlot('B', 'PP1', 'Week 1', 0, 'Bench', 30),
        rosterSlot('B', 'SF', 'Week 1', 2, 'SF Guy', 20),
      ],
      weeklyBatting: CARRY_WEEKLY,
      scheduleDates: ROSTER_DATES,
      schedule: ROSTER_SCHEDULE,
      managers: ['A', 'B'],
    });

  it('finds the most recent round a manager actually rostered someone', () => {
    const last = lastKnownRoster(carrySnapshot(), 'A', 'SF');
    assert.equal(last.round, 'PP1');
    assert.deepEqual(last.batters, ['Starter']);
  });

  it('returns null for a manager who never rostered anyone', () => {
    assert.equal(lastKnownRoster(carrySnapshot(), 'Nobody', 'SF'), null);
  });

  it('returns null when there is no earlier round to carry from', () => {
    assert.equal(lastKnownRoster(carrySnapshot(), 'A', 'PP1'), null);
  });

  it('walks back past a round the manager missed', () => {
    // B played PP1 and SF but not the intervening rounds; carrying into SF finds PP1.
    const last = lastKnownRoster(carrySnapshot(), 'B', 'SF');
    assert.equal(last.round, 'PP1');
    assert.deepEqual(last.batters, ['Bench']);
  });

  it('prices a carried roster against the target round stats, not the old ones', () => {
    // He scored 20 across PP1, but only 10 in the semifinal — the carried roster is priced on the
    // round it is carried INTO, which is the whole point.
    const score = scoreRosterForRound(carrySnapshot(), 'A', 'SF', { batters: ['Starter'], pitchers: [] });
    assert.equal(score, 10);
  });

  it('prices a carried roster under the scenario scoring table', () => {
    const score = scoreRosterForRound(
      carrySnapshot(),
      'A',
      'SF',
      { batters: ['Starter'], pitchers: [] },
      { scoring: { batting: { HR: 20 } } }
    );
    assert.equal(score, 20, 'his one SF home run is now worth double');
  });

  it('scores zero for a carried roster whose players did nothing that round', () => {
    assert.equal(scoreRosterForRound(carrySnapshot(), 'A', 'SF', { batters: ['Nobody'], pitchers: [] }), 0);
  });
});

describe('rounds the league has not played', () => {
  it('knows which rounds have recorded stats', () => {
    const snapshot = buildSnapshot({
      weeklyBatting: [{ batter: 'X', round: 'PP1', week: 'Week 1', weekly_score: 5 }],
      schedule: ROSTER_SCHEDULE,
    });
    assert.equal(roundHasStats(snapshot, 'PP1'), true);
    assert.equal(roundHasStats(snapshot, 'SF'), false);
  });

  it('counts a pitching-only round as played', () => {
    const snapshot = buildSnapshot({
      weeklyPitching: [{ pitcher: 'P', round: 'SF', week: 'Week 1', weekly_score: 5 }],
      schedule: ROSTER_SCHEDULE,
    });
    assert.equal(roundHasStats(snapshot, 'SF'), true);
  });
});

describe('statCoverage — why a round refuses to move', () => {
  const schedule2 = [
    { round: 'PP1', week: 'Week 1' },
    { round: 'PP2', week: 'Week 1' },
  ];
  const dates2 = [
    { start: '2026-03-26', end: '2026-04-01' },
    { start: '2026-04-02', end: '2026-04-08' },
  ];
  const weekly2 = [
    { batter: 'P', round: 'PP1', week: 'Week 1', hr: 1, so: 5, weekly_score: 10 },
    { batter: 'P', round: 'PP2', week: 'Week 1', hr: 1, so: 5, weekly_score: 10 },
  ];
  const slot2 = (round, week, weekIdx) => rosterSlot('A', round, week, weekIdx, 'P', 10);
  const build = (daily) =>
    buildSnapshot({
      slots: [slot2('PP1', 'Week 1', 0), slot2('PP2', 'Week 1', 1)],
      dailyBatting: daily,
      weeklyBatting: weekly2,
      scheduleDates: dates2,
      schedule: schedule2,
      managers: ['A'],
    });

  it('reports the stat as both scored and recorded on the weekly path', () => {
    assert.deepEqual(statCoverage(build([]), 'batting', 'SO', 'PP1'), { scored: 5, recorded: 5 });
  });

  it('flags a round whose per-game rows omit the stat the weekly totals record', () => {
    const snapshot = build([
      { batter: 'P', round: 'PP1', week: 'Week 1', date: '2026-03-27', delta: { hr: 1 } },
      { batter: 'P', round: 'PP2', week: 'Week 1', date: '2026-04-03', delta: { hr: 1, so: 5 } },
    ]);
    assert.deepEqual(statCoverage(snapshot, 'batting', 'SO', 'PP1'), { scored: 0, recorded: 5 });
    assert.deepEqual(statCoverage(snapshot, 'batting', 'SO', 'PP2'), { scored: 5, recorded: 5 });
  });

  it('flags a round whose per-game rows fall outside its own calendar', () => {
    const snapshot = build([
      { batter: 'P', round: 'PP1', week: 'Week 1', date: '2026-02-01', delta: { hr: 1, so: 5 } },
      { batter: 'P', round: 'PP2', week: 'Week 1', date: '2026-04-03', delta: { hr: 1, so: 5 } },
    ]);
    assert.deepEqual(statCoverage(snapshot, 'batting', 'SO', 'PP1'), { scored: 0, recorded: 5 });
  });

  it('reports a genuinely absent stat as zero on both counts', () => {
    const snapshot = buildSnapshot({
      slots: [slot2('PP1', 'Week 1', 0)],
      weeklyBatting: [{ batter: 'P', round: 'PP1', week: 'Week 1', hr: 1, weekly_score: 10 }],
      scheduleDates: dates2,
      schedule: schedule2,
      managers: ['A'],
    });
    assert.deepEqual(statCoverage(snapshot, 'batting', 'SO', 'PP1'), { scored: 0, recorded: 0 });
  });

  it('returns zero for a key that maps to no stat field', () => {
    assert.deepEqual(statCoverage(build([]), 'batting', 'NOPE', 'PP1'), { scored: 0, recorded: 0 });
  });

  it('summarises coverage for every changed scoring value', () => {
    const snapshot = build([]);
    const cov = scenarioStatCoverage(snapshot, { scoring: { batting: { SO: -2 } } }, ['PP1', 'PP2']);
    assert.equal(cov.length, 1);
    assert.equal(cov[0].key, 'SO');
    assert.deepEqual(
      cov[0].rounds.map((r) => r.round),
      ['PP1', 'PP2']
    );
    assert.equal(cov[0].rounds[0].scored, 5);
  });
});
