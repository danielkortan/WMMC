import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodStartForRound,
  isPlayerActiveAsOfWeekEnd,
  isGameDateEligible,
  isManagerActiveInRound,
  isManagerInRound,
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

describe('isManagerActiveInRound', () => {
  it('never restricts pool play — every manager plays PP1 and PP2', () => {
    assert.equal(isManagerActiveInRound('PP1', 'PP'), true);
    assert.equal(isManagerActiveInRound('PP2', 'PP'), true);
    assert.equal(isManagerActiveInRound('PP2', 'QF'), true);
  });

  it('a manager who missed the playoff field is out of every playoff round', () => {
    assert.equal(isManagerActiveInRound('QF', 'PP'), false);
    assert.equal(isManagerActiveInRound('SF', 'PP'), false);
    assert.equal(isManagerActiveInRound('Finals', 'PP'), false);
  });

  it('a manager eliminated IN a round still played that round', () => {
    assert.equal(isManagerActiveInRound('QF', 'QF'), true); // lost the QF — but played it
    assert.equal(isManagerActiveInRound('SF', 'QF'), false);
    assert.equal(isManagerActiveInRound('SF', 'SF'), true);
    assert.equal(isManagerActiveInRound('Finals', 'SF'), false);
    assert.equal(isManagerActiveInRound('Finals', 'Finals'), true); // runner-up / 4th place
  });

  it('a manager who was never eliminated is active everywhere', () => {
    for (const r of ['PP1', 'PP2', 'QF', 'SF', 'Finals']) {
      assert.equal(isManagerActiveInRound(r, null), true);
      assert.equal(isManagerActiveInRound(r, undefined), true);
    }
  });

  it('fails open on rounds it does not recognize — never hide on unreadable data', () => {
    assert.equal(isManagerActiveInRound('QF', 'Wildcard'), true);
    assert.equal(isManagerActiveInRound('Consolation', 'PP'), true);
    assert.equal(isManagerActiveInRound(null, 'PP'), true);
  });
});

describe('isManagerInRound', () => {
  const eliminated = { Austin: 'PP', Cam: 'QF' };

  it('pool play is open to everyone, whatever the sources say', () => {
    assert.equal(isManagerInRound('Austin', 'PP1', { participants: ['Ryan'], eliminated }), true);
    assert.equal(isManagerInRound('Austin', 'PP2', { participants: ['Ryan'], eliminated }), true);
  });

  it('the bracket field is authoritative when known — anyone not in it is out', () => {
    const participants = ['Ryan', 'Cam'];
    assert.equal(isManagerInRound('Ryan', 'QF', { participants, eliminated }), true);
    assert.equal(isManagerInRound('Austin', 'QF', { participants, eliminated }), false);
    // Not in the SF field, even though sd.eliminated hasn't been written yet.
    assert.equal(isManagerInRound('Cam', 'SF', { participants: ['Ryan'], eliminated: {} }), false);
  });

  it('falls back to sd.eliminated before the bracket is derivable', () => {
    assert.equal(isManagerInRound('Austin', 'QF', { participants: [], eliminated }), false);
    assert.equal(isManagerInRound('Cam', 'QF', { participants: null, eliminated }), true);
    assert.equal(isManagerInRound('Cam', 'SF', { participants: [], eliminated }), false);
    assert.equal(isManagerInRound('Ryan', 'Finals', { participants: [], eliminated }), true);
  });

  it('ignores blank participant entries rather than treating them as a known field', () => {
    // A half-built bracket (missing names) must not silently exclude everyone.
    assert.equal(isManagerInRound('Ryan', 'QF', { participants: [null, '', undefined], eliminated }), true);
    assert.equal(isManagerInRound('Austin', 'QF', { participants: [null, ''], eliminated }), false);
  });

  it('with nothing known at all, nobody is filtered out', () => {
    assert.equal(isManagerInRound('Anyone', 'Finals', {}), true);
    assert.equal(isManagerInRound('Anyone', 'Finals'), true);
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
