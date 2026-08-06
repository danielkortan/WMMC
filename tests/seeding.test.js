import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seedFromPeriodTotals } from '../js/seeding.js';

// Shorthand: a manager whose points are all batting, which keeps the tiebreak columns predictable.
const e = (manager, pool, pp1, pp2) => ({ manager, pool, pp1Bat: pp1, pp1Pit: 0, pp2Bat: pp2, pp2Pit: 0 });

describe('seedFromPeriodTotals', () => {
  it('returns null with no entries', () => {
    assert.equal(seedFromPeriodTotals([]), null);
    assert.equal(seedFromPeriodTotals(null), null);
  });

  it('crowns a PP1 and PP2 leader in each pool', () => {
    const r = seedFromPeriodTotals([
      e('A', 'P1', 100, 10),
      e('B', 'P1', 10, 100),
      e('C', 'P2', 50, 50),
      e('D', 'P2', 10, 10),
    ]);
    assert.deepEqual([...r.pp1Leaders].sort(), ['A', 'C']);
    assert.deepEqual([...r.pp2Leaders].sort(), ['B', 'C']);
    assert.equal(r.byManager.C.periodsWon, 2, 'C won both periods in its pool');
    assert.equal(r.byManager.A.periodsWon, 1);
  });

  it('treats a pool with no scoring as having no leader', () => {
    const r = seedFromPeriodTotals([e('A', 'P1', 0, 0), e('B', 'P1', 0, 0)]);
    assert.equal(r.pp1Leaders.size, 0);
    assert.equal(r.pp2Leaders.size, 0);
    assert.deepEqual(r.qualifierNames, [], 'nobody with zero points qualifies');
  });

  it('seeds every pool winner above every wildcard, even on a lower total', () => {
    const r = seedFromPeriodTotals(
      [
        e('Winner', 'P1', 10, 10), // wins its pool but scores little
        e('Loser', 'P1', 5, 5),
        e('BigWinner', 'P2', 500, 500),
        e('BigRunnerUp', 'P2', 400, 400), // huge total, but no period won
      ],
      { bracketSize: 4 }
    );
    assert.equal(r.byManager.Winner.isPoolWinner, true);
    assert.equal(r.byManager.BigRunnerUp.isPoolWinner, false);
    assert.ok(
      r.qualifierNames.indexOf('Winner') < r.qualifierNames.indexOf('BigRunnerUp'),
      'a pool winner outranks a higher-scoring wildcard'
    );
  });

  it('fills the remaining seeds with the top non-winners', () => {
    const r = seedFromPeriodTotals(
      [e('A', 'P1', 100, 100), e('B', 'P1', 90, 90), e('C', 'P2', 80, 80), e('D', 'P2', 70, 70), e('E', 'P3', 5, 5)],
      { bracketSize: 4 }
    );
    assert.equal(r.qualifierNames.length, 4);
    assert.equal(r.wildcardSet.has('B'), true, 'B is the highest-scoring non-winner');
    assert.equal(r.qualifierNames.includes('D'), false, 'D misses the cut');
  });

  it('never seeds a manager with zero points as a wildcard', () => {
    const r = seedFromPeriodTotals([e('A', 'P1', 100, 100), e('Zero', 'P1', 0, 0)], { bracketSize: 8 });
    assert.equal(r.qualifierNames.includes('Zero'), false);
  });

  it('breaks a total tie on periods won', () => {
    const r = seedFromPeriodTotals([e('Won', 'P1', 100, 100), e('Lost', 'P1', 99, 101), e('Other', 'P2', 200, 0)], {
      bracketSize: 8,
    });
    // Won takes PP1 (100 > 99), Lost takes PP2 (101 > 100) — both 200 total, both won a period.
    assert.equal(r.byManager.Won.total, r.byManager.Lost.total);
    assert.equal(r.byManager.Won.periodsWon, 1);
    assert.equal(r.byManager.Lost.periodsWon, 1);
  });

  it('ranks a two-period winner above a one-period winner on the same total', () => {
    const r = seedFromPeriodTotals([e('Sweep', 'P1', 100, 100), e('Split', 'P2', 100, 100), e('Weak', 'P2', 99, 0)], {
      bracketSize: 8,
    });
    assert.equal(r.byManager.Sweep.periodsWon, 2);
    assert.equal(r.byManager.Split.periodsWon, 2);
    assert.ok(r.qualifierNames.includes('Sweep') && r.qualifierNames.includes('Split'));
  });

  it('resolves an exact period tie in favor of the earlier entry', () => {
    const first = seedFromPeriodTotals([e('First', 'P1', 100, 0), e('Second', 'P1', 100, 0)]);
    assert.equal(first.pp1Leaders.has('First'), true);
    assert.equal(first.pp1Leaders.has('Second'), false);
  });

  it('numbers the seeds from one and caps at the bracket size', () => {
    const r = seedFromPeriodTotals(
      [e('A', 'P1', 100, 100), e('B', 'P1', 90, 90), e('C', 'P2', 80, 80), e('D', 'P2', 70, 70)],
      { bracketSize: 2 }
    );
    assert.equal(r.seeds.length, 2);
    assert.deepEqual(
      r.seeds.map((s) => s.seed),
      [1, 2]
    );
  });

  it('rounds period and total columns to cents', () => {
    const r = seedFromPeriodTotals([{ manager: 'A', pool: 'P1', pp1Bat: 0.1, pp1Pit: 0.2, pp2Bat: 0, pp2Pit: 0 }]);
    assert.equal(r.byManager.A.pp1, 0.3, '0.1 + 0.2 must not leak float noise');
  });

  it('ignores entries with no manager name', () => {
    const r = seedFromPeriodTotals([e('A', 'P1', 10, 10), { pool: 'P1' }]);
    assert.equal(Object.keys(r.byManager).length, 1);
  });
});
