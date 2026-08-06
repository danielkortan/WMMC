import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WMMC_HISTORICAL_RESULTS,
  HISTORICAL_NAME_ALIASES,
  canonicalManagerName,
  exitStageForPlace,
  managerPlayoffHistory,
} from '../js/history.js';

// A compact stand-in for the real table, so the assertions below describe the RULES rather
// than the league's actual results (which change once a year).
const FIXTURE = [
  { year: '2020', champion: 'A', runnerUp: 'B', third: 'C', standings: { A: 1, B: 2, C: 3, D: 4, E: 5, F: 9 } },
  { year: '2021', champion: 'B', runnerUp: 'A', third: 'D', standings: { B: 1, A: 2, D: 3, C: 4, E: 6, F: 10 } },
  { year: '2022', champion: 'C', runnerUp: 'D', third: 'A', standings: { C: 1, D: 2, A: 3, B: 8, E: 7, F: 11 } },
  { year: '2023', champion: 'D', runnerUp: 'C', third: 'B', standings: { D: 1, C: 2, B: 3, A: 5, E: 5, F: 12 } },
];

describe('exitStageForPlace', () => {
  it('maps a final placing to the round the manager went out in', () => {
    assert.equal(exitStageForPlace(1), 'Finals');
    assert.equal(exitStageForPlace(2), 'Finals');
    assert.equal(exitStageForPlace(3), 'SF');
    assert.equal(exitStageForPlace(4), 'SF');
    assert.equal(exitStageForPlace(5), 'QF');
    assert.equal(exitStageForPlace(8), 'QF');
    assert.equal(exitStageForPlace(9), 'DNQ');
    assert.equal(exitStageForPlace(12), 'DNQ');
  });

  it('honours a non-default field size', () => {
    assert.equal(exitStageForPlace(5, 4), 'DNQ');
    assert.equal(exitStageForPlace(4, 4), 'SF');
  });

  it('returns null for a missing or nonsense placing', () => {
    assert.equal(exitStageForPlace(0), null);
    assert.equal(exitStageForPlace(null), null);
    assert.equal(exitStageForPlace(undefined), null);
  });
});

describe('canonicalManagerName', () => {
  it('maps a historical spelling onto the current commissioner-page name', () => {
    assert.equal(canonicalManagerName('Dan Kortan'), 'Daniel Kortan');
  });

  it('passes an unaliased name through untouched', () => {
    assert.equal(canonicalManagerName('Jamie Rogers'), 'Jamie Rogers');
    assert.equal(canonicalManagerName(''), '');
    assert.equal(canonicalManagerName(null), '');
  });
});

describe('managerPlayoffHistory', () => {
  it('summarizes a career across the seasons a manager actually played', () => {
    const h = managerPlayoffHistory('A', FIXTURE, { throughYear: 2024 });
    assert.equal(h.seasonsPlayed, 4);
    assert.deepEqual(h.titles, [2020]);
    assert.equal(h.titleCount, 1);
    assert.equal(h.lastTitle, 2020);
    assert.deepEqual(h.runnerUps, [2021]);
    assert.equal(h.finalsAppearances, 2);
    assert.equal(h.sfExitCount, 1); // 2022, 3rd
    assert.equal(h.qfExitCount, 1); // 2023, 5th
    assert.equal(h.dnqCount, 0);
    assert.equal(h.lastStage, 'QF');
    assert.equal(h.lastYear, 2023);
  });

  it('excludes the season in progress via throughYear', () => {
    const withAll = managerPlayoffHistory('A', FIXTURE, { throughYear: 2024 });
    const upTo2023 = managerPlayoffHistory('A', FIXTURE, { throughYear: 2023 });
    assert.equal(withAll.seasonsPlayed, 4);
    assert.equal(upTo2023.seasonsPlayed, 3);
    assert.equal(upTo2023.lastYear, 2022);
  });

  it('counts a same-stage streak only from the most recent season backwards', () => {
    // F: 9th, 10th, 11th, 12th — four straight seasons out of the bracket.
    const f = managerPlayoffHistory('F', FIXTURE, { throughYear: 2024 });
    assert.equal(f.currentStageStreak, 4);
    assert.equal(f.dnqCount, 4);
    // A ends on a single QF exit after a Finals run, so the streak is 1, not 4.
    const a = managerPlayoffHistory('A', FIXTURE, { throughYear: 2024 });
    assert.equal(a.currentStageStreak, 1);
  });

  it('flags a manager who has never reached a Final', () => {
    const e = managerPlayoffHistory('E', FIXTURE, { throughYear: 2024 });
    assert.equal(e.neverMadeFinals, true);
    assert.equal(e.neverPastQF, true);
    assert.equal(e.playoffAppearances, 4);
    assert.equal(e.lastYearInFinals, null);
    assert.equal(e.lastYearInSemis, null);
  });

  it('records the last year a manager reached each stage', () => {
    const b = managerPlayoffHistory('B', FIXTURE, { throughYear: 2024 });
    assert.equal(b.lastYearInFinals, 2021);
    assert.equal(b.lastYearInSemis, 2023); // 3rd place in 2023 is a semifinal loss
  });

  it('resolves an aliased historical name to one career, not two', () => {
    const aliased = [
      { year: '2020', standings: { 'Dan Kortan': 1, X: 2 } },
      { year: '2021', standings: { 'Daniel Kortan': 3, X: 1 } },
    ];
    const h = managerPlayoffHistory('Daniel Kortan', aliased, { throughYear: 2026 });
    assert.equal(h.seasonsPlayed, 2);
    assert.deepEqual(h.titles, [2020]);
    // ...and looking it up under the OLD spelling finds the same career.
    const viaOld = managerPlayoffHistory('Dan Kortan', aliased, { throughYear: 2026 });
    assert.deepEqual(viaOld, h);
  });

  it('returns null for a manager with no recorded finish', () => {
    assert.equal(managerPlayoffHistory('Nobody', FIXTURE, { throughYear: 2024 }), null);
    assert.equal(managerPlayoffHistory('', FIXTURE, { throughYear: 2024 }), null);
  });
});

describe('WMMC_HISTORICAL_RESULTS', () => {
  it('has one entry per season with a champion and a standings table', () => {
    assert.ok(WMMC_HISTORICAL_RESULTS.length >= 8);
    for (const row of WMMC_HISTORICAL_RESULTS) {
      assert.match(row.year, /^\d{4}$/);
      assert.ok(row.champion, `${row.year} has a champion`);
      assert.ok(row.standings && Object.keys(row.standings).length > 0, `${row.year} has standings`);
    }
  });

  it('agrees with its own standings about who finished 1st, 2nd and 3rd', () => {
    for (const row of WMMC_HISTORICAL_RESULTS) {
      const byPlace = {};
      for (const [name, place] of Object.entries(row.standings)) byPlace[place] = name;
      assert.equal(byPlace[1], row.champion, `${row.year} champion`);
      assert.equal(byPlace[2], row.runnerUp, `${row.year} runner-up`);
      assert.equal(byPlace[3], row.third, `${row.year} third`);
    }
  });

  it('gives every season a gapless 1..N placing', () => {
    for (const row of WMMC_HISTORICAL_RESULTS) {
      const places = Object.values(row.standings).sort((a, b) => a - b);
      assert.deepEqual(
        places,
        places.map((_, i) => i + 1),
        `${row.year} placings are 1..${places.length}`
      );
    }
  });

  it('only aliases names that actually appear in the tables', () => {
    const seen = new Set();
    for (const row of WMMC_HISTORICAL_RESULTS) Object.keys(row.standings).forEach((n) => seen.add(n));
    for (const old of Object.keys(HISTORICAL_NAME_ALIASES)) {
      assert.ok(seen.has(old), `${old} appears in the historical standings`);
    }
  });
});
