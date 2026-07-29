import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodStartForRound,
  isPlayerActiveAsOfWeekEnd,
  isGameDateEligible,
  rosterStatusAsOf,
  periodWeekKeys,
  rosterStatusForManager,
} from '../js/eligibility.js';

// A compact schedule spanning a period boundary (PP1 → PP2), with a gap, to exercise the rules.
const schedule = [
  { round: 'PP1', week: 'Week 1' },
  { round: 'PP1', week: 'Week 2' },
  { round: 'PP2', week: 'Week 1' },
];
const scheduleDates = [
  { start: '2026-05-04', end: '2026-05-10' },
  { start: '2026-05-11', end: '2026-05-17' },
  { start: '2026-06-08', end: '2026-06-14' },
];

describe('periodStartForRound', () => {
  it('returns null for the initial period (no prior period to exclude)', () => {
    assert.equal(periodStartForRound('PP1', schedule, scheduleDates), null);
  });
  it("returns a later period's first-week start", () => {
    assert.equal(periodStartForRound('PP2', schedule, scheduleDates), '2026-06-08');
  });
  it('returns null for an unknown round or empty schedule', () => {
    assert.equal(periodStartForRound('QF', schedule, scheduleDates), null);
    assert.equal(periodStartForRound('PP2', [], []), null);
    assert.equal(periodStartForRound(null, schedule, scheduleDates), null);
  });
});

describe('isPlayerActiveAsOfWeekEnd — within a period', () => {
  it('a player added at the period start is active all week (no drop)', () => {
    const e = [{ add_date: '2026-05-04' }];
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { periodStart: null, weekEnd: '2026-05-10' }), true);
  });

  it('a mid-period add does not count for weeks that ended before the add', () => {
    const e = [{ add_date: '2026-05-15' }];
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-10' }), false); // Week 1 ended 5/10
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-17' }), true); // Week 2 ended 5/17
  });

  it('a drop ends eligibility from the drop onward, but not before', () => {
    const e = [{ add_date: '2026-05-04' }, { drop_date: '2026-05-12' }];
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-10' }), true); // not yet dropped at W1 end
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-17' }), false); // dropped before W2 end
  });

  it('a swap pair (add then later drop) is active between the two', () => {
    const e = [{ add_date: '2026-05-10' }, { drop_date: '2026-05-20' }];
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-17' }), true);
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-31' }), false);
  });

  it('a re-add after a drop restores eligibility (latest add wins)', () => {
    const e = [{ add_date: '2026-05-04' }, { drop_date: '2026-05-10' }, { add_date: '2026-05-20' }];
    assert.equal(isPlayerActiveAsOfWeekEnd(e, { weekEnd: '2026-05-31' }), true);
  });

  it('no add at all means not rostered', () => {
    assert.equal(isPlayerActiveAsOfWeekEnd([{ drop_date: '2026-05-12' }], { weekEnd: '2026-05-17' }), false);
    assert.equal(isPlayerActiveAsOfWeekEnd([], { weekEnd: '2026-05-17' }), false);
  });
});

describe('isPlayerActiveAsOfWeekEnd — period boundary (the PP1→PP2 leak the fix prevents)', () => {
  // A player added in PP1 with no PP2 add: a global carry-forward would wrongly keep them active in
  // PP2; period scoping excludes the PP1 add, so they are NOT rostered in PP2.
  const pp1Only = [{ add_date: '2026-05-04' }];

  it('is active in PP1 (no period lower bound)', () => {
    const periodStart = periodStartForRound('PP1', schedule, scheduleDates); // null
    assert.equal(isPlayerActiveAsOfWeekEnd(pp1Only, { periodStart, weekEnd: '2026-05-10' }), true);
  });

  it('is NOT active in PP2 (PP1 add is before the PP2 period start)', () => {
    const periodStart = periodStartForRound('PP2', schedule, scheduleDates); // 2026-06-08
    assert.equal(isPlayerActiveAsOfWeekEnd(pp1Only, { periodStart, weekEnd: '2026-06-14' }), false);
  });

  it('a player re-submitted for PP2 (PP2 add) IS active in PP2', () => {
    const kept = [{ add_date: '2026-05-04' }, { add_date: '2026-06-08' }];
    const periodStart = periodStartForRound('PP2', schedule, scheduleDates);
    assert.equal(isPlayerActiveAsOfWeekEnd(kept, { periodStart, weekEnd: '2026-06-14' }), true);
  });
});

describe('rosterStatusAsOf — a swap already in effect', () => {
  const today = '2026-05-12';

  it('reads an add with no drop as active', () => {
    assert.equal(rosterStatusAsOf([{ add_date: '2026-05-04' }], { asOf: today }), 'active');
  });

  it('reads a drop on/before today as dropped', () => {
    const e = [{ add_date: '2026-05-04' }, { drop_date: '2026-05-12' }];
    assert.equal(rosterStatusAsOf(e, { asOf: today }), 'dropped');
  });

  it('reads a re-add after a drop as active again', () => {
    const e = [{ add_date: '2026-05-04' }, { drop_date: '2026-05-08' }, { add_date: '2026-05-10' }];
    assert.equal(rosterStatusAsOf(e, { asOf: today }), 'active');
  });

  it('reads a player with no dates at all as none', () => {
    assert.equal(rosterStatusAsOf([], { asOf: today }), 'none');
    assert.equal(rosterStatusAsOf(null, { asOf: today }), 'none');
  });
});

describe('rosterStatusAsOf — a SCHEDULED (future-dated) swap must not apply early', () => {
  // The reported case: on 7/28 a swap is submitted effective 7/31 — Drohan out (drop 7/30),
  // Mize in (add 7/31). Both date windows are recorded immediately, but neither has happened.
  const today = '2026-07-28';
  const outgoing = [{ add_date: '2026-07-24' }, { drop_date: '2026-07-30' }];
  const incoming = [{ add_date: '2026-07-31' }];

  it('keeps the outgoing player active until their drop date', () => {
    assert.equal(rosterStatusAsOf(outgoing, { asOf: today }), 'active');
    assert.equal(rosterStatusAsOf(outgoing, { asOf: '2026-07-29' }), 'active');
    assert.equal(rosterStatusAsOf(outgoing, { asOf: '2026-07-30' }), 'dropped'); // drop day is inclusive
  });

  it('holds the incoming player as scheduled until their add date', () => {
    assert.equal(rosterStatusAsOf(incoming, { asOf: today }), 'scheduled');
    assert.equal(rosterStatusAsOf(incoming, { asOf: '2026-07-30' }), 'scheduled');
    assert.equal(rosterStatusAsOf(incoming, { asOf: '2026-07-31' }), 'active');
  });

  it('keeps a submission player (no add_date) active until a scheduled drop lands', () => {
    const submitted = [{ drop_date: '2026-07-30' }];
    assert.equal(rosterStatusAsOf(submitted, { asOf: today }), 'active');
    assert.equal(rosterStatusAsOf(submitted, { asOf: '2026-07-30' }), 'dropped');
  });

  it('treats a scheduled drop-then-readd as still rostered now', () => {
    const e = [{ drop_date: '2026-07-30' }, { add_date: '2026-08-01' }];
    assert.equal(rosterStatusAsOf(e, { asOf: today }), 'active');
  });

  it('without asOf, future dates read as already applied (past-tense reading)', () => {
    assert.equal(rosterStatusAsOf(outgoing, {}), 'dropped');
    assert.equal(rosterStatusAsOf(incoming, {}), 'active');
  });
});

describe('rosterStatusAsOf — period scoping', () => {
  it("ignores a prior period's add so a holdover is not rostered in the new period", () => {
    const pp1Only = [{ add_date: '2026-05-04' }];
    assert.equal(rosterStatusAsOf(pp1Only, { periodStart: '2026-06-08', asOf: '2026-06-10' }), 'none');
  });

  it('honors an add made for the new period', () => {
    const kept = [{ add_date: '2026-05-04' }, { add_date: '2026-06-08' }];
    assert.equal(rosterStatusAsOf(kept, { periodStart: '2026-06-08', asOf: '2026-06-10' }), 'active');
  });

  it('a scheduled add inside the new period reads as scheduled, not none', () => {
    const e = [{ add_date: '2026-06-12' }];
    assert.equal(rosterStatusAsOf(e, { periodStart: '2026-06-08', asOf: '2026-06-10' }), 'scheduled');
  });
});

describe('isGameDateEligible', () => {
  const week = { weekStart: '2026-05-04', weekEnd: '2026-05-10' };

  it('counts games inside the week window', () => {
    assert.equal(isGameDateEligible('2026-05-05', week), true);
    assert.equal(isGameDateEligible('2026-05-04', week), true); // inclusive start
    assert.equal(isGameDateEligible('2026-05-10', week), true); // inclusive end
  });

  it('excludes games before the week start or after the week end', () => {
    assert.equal(isGameDateEligible('2026-05-03', week), false);
    assert.equal(isGameDateEligible('2026-05-11', week), false);
  });

  it('an add_date override replaces the start bound (no scoring before the add)', () => {
    assert.equal(isGameDateEligible('2026-05-05', { ...week, addDate: '2026-05-06' }), false);
    assert.equal(isGameDateEligible('2026-05-07', { ...week, addDate: '2026-05-06' }), true);
  });

  it('a drop_date override replaces the end bound (no scoring after the drop)', () => {
    assert.equal(isGameDateEligible('2026-05-09', { ...week, dropDate: '2026-05-08' }), false);
    assert.equal(isGameDateEligible('2026-05-08', { ...week, dropDate: '2026-05-08' }), true); // inclusive
  });
});

describe('periodWeekKeys', () => {
  it("returns only the round's own week keys, in schedule order", () => {
    assert.deepEqual(periodWeekKeys('PP1', schedule), ['PP1|Week 1', 'PP1|Week 2']);
    assert.deepEqual(periodWeekKeys('PP2', schedule), ['PP2|Week 1']);
  });
  it('returns an empty list for an unknown round or a missing schedule', () => {
    assert.deepEqual(periodWeekKeys('QF', schedule), []);
    assert.deepEqual(periodWeekKeys(null, schedule), []);
    assert.deepEqual(periodWeekKeys('PP1', null), []);
  });
});

// The playoff shape that produced the bug: a manager eliminated in the QF keeps their QF roster
// array and QF roster_dates, while the surviving managers are playing the SF.
describe('rosterStatusForManager', () => {
  const playoffSchedule = [
    { round: 'QF', week: 'Week 1' },
    { round: 'QF', week: 'Week 2' },
    { round: 'SF', week: 'Week 1' },
    { round: 'SF', week: 'Week 2' },
  ];
  const sfWeeks = periodWeekKeys('SF', playoffSchedule);
  const sfStart = '2026-07-20';
  const today = '2026-07-29';

  const eliminated = {
    rosterDates: { 'QF|Week 1': { Skubal: { add_date: '2026-07-06' } } },
    rosters: {
      'QF|Week 1': { batters: [], pitchers: ['Skubal'] },
      'QF|Week 2': { batters: [], pitchers: ['Skubal'] },
    },
  };

  it('an eliminated manager does not hold a player into the next period (date windows)', () => {
    assert.equal(
      rosterStatusForManager('Skubal', {
        ...eliminated,
        periodStart: sfStart,
        asOf: today,
        weekKeys: sfWeeks,
      }),
      'none'
    );
  });

  it("an eliminated manager's stale roster array is not read as a live roster", () => {
    // Same manager, but with no roster_dates at all — the array fallback is the only signal, and
    // it must stay inside the current period's weeks.
    const arraysOnly = { rosterDates: {}, rosters: eliminated.rosters };
    assert.equal(
      rosterStatusForManager('Skubal', { ...arraysOnly, periodStart: sfStart, asOf: today, weekKeys: sfWeeks }),
      'none'
    );
    // ...while the QF itself still reads him as rostered.
    assert.equal(
      rosterStatusForManager('Skubal', {
        ...arraysOnly,
        periodStart: null,
        asOf: '2026-07-10',
        weekKeys: periodWeekKeys('QF', playoffSchedule),
      }),
      'active'
    );
  });

  it('a manager who submitted the player for THIS period still holds him', () => {
    const surviving = {
      rosterDates: { 'SF|Week 1': { Skubal: { add_date: sfStart } } },
      rosters: { 'SF|Week 1': { batters: [], pitchers: ['Skubal'] } },
    };
    assert.equal(
      rosterStatusForManager('Skubal', { ...surviving, periodStart: sfStart, asOf: today, weekKeys: sfWeeks }),
      'active'
    );
  });

  it('falls back to this period’s roster array when the player has no date entries', () => {
    const noDates = {
      rosterDates: { 'SF|Week 1': { Someone: { add_date: sfStart } } },
      rosters: { 'SF|Week 1': { batters: ['Judge'], pitchers: [] } },
    };
    assert.equal(
      rosterStatusForManager('Judge', { ...noDates, periodStart: sfStart, asOf: today, weekKeys: sfWeeks }),
      'active'
    );
    assert.equal(
      rosterStatusForManager('Ohtani', { ...noDates, periodStart: sfStart, asOf: today, weekKeys: sfWeeks }),
      'none'
    );
  });

  it('a player dropped within the period is released even if the arrays still list him', () => {
    const dropped = {
      rosterDates: { 'SF|Week 1': { Skubal: { add_date: sfStart, drop_date: '2026-07-27' } } },
      rosters: { 'SF|Week 1': { batters: [], pitchers: ['Skubal'] } },
    };
    assert.equal(
      rosterStatusForManager('Skubal', { ...dropped, periodStart: sfStart, asOf: today, weekKeys: sfWeeks }),
      'dropped'
    );
  });

  it('a scheduled swap does not move either player before its effective date', () => {
    const scheduled = {
      rosterDates: {
        'SF|Week 1': {
          Skubal: { add_date: sfStart, drop_date: '2026-07-31' }, // still on the roster today
          Wheeler: { add_date: '2026-08-01' }, // claimed, but not rostered yet
        },
      },
      rosters: { 'SF|Week 1': { batters: [], pitchers: ['Wheeler'] } },
    };
    const opts = { ...scheduled, periodStart: sfStart, asOf: today, weekKeys: sfWeeks };
    assert.equal(rosterStatusForManager('Skubal', opts), 'active');
    assert.equal(rosterStatusForManager('Wheeler', opts), 'scheduled');
  });

  it('handles a manager with no roster data at all', () => {
    assert.equal(rosterStatusForManager('Skubal', { periodStart: sfStart, asOf: today, weekKeys: sfWeeks }), 'none');
  });
});
