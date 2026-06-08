import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { periodStartForRound, isPlayerActiveAsOfWeekEnd, isGameDateEligible } from '../js/eligibility.js';

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
