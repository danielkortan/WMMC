import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dateInWindow, diffEligibility, isFullWeek, weekRosterWindows, windowAsDates } from '../js/rosterWindows.js';

// Every case below is an incident this league actually had. Each one is a bug that shipped; each
// one should be a test that fails without its fix.

const WEEK = { weekStart: '2026-05-18', weekEnd: '2026-05-24' };

describe('weekRosterWindows — the plain cases', () => {
  it('gives a player held all week the whole week', () => {
    const w = weekRosterWindows({
      ...WEEK,
      mgrDates: { 'PP1|Week 1': { 'Aaron Judge': { add_date: '2026-05-04' } } },
    });
    assert.deepEqual(w['Aaron Judge'], { start: '2026-05-18', end: '2026-05-24' });
    assert.equal(isFullWeek(w['Aaron Judge'], WEEK.weekStart, WEEK.weekEnd), true);
  });

  it('clips to the add when he arrives mid-week', () => {
    const w = weekRosterWindows({ ...WEEK, mgrDates: { 'PP1|Week 3': { X: { add_date: '2026-05-21' } } } });
    assert.deepEqual(w.X, { start: '2026-05-21', end: '2026-05-24' });
    assert.equal(isFullWeek(w.X, WEEK.weekStart, WEEK.weekEnd), false);
  });

  it('treats drop_date as INCLUSIVE — the drop day still scores', () => {
    const w = weekRosterWindows({
      ...WEEK,
      mgrDates: { 'PP1|Week 3': { X: { add_date: '2026-05-04', drop_date: '2026-05-21' } } },
    });
    assert.deepEqual(w.X, { start: '2026-05-18', end: '2026-05-21' });
    assert.equal(dateInWindow(w.X, '2026-05-21'), true);
    assert.equal(dateInWindow(w.X, '2026-05-22'), false);
  });

  it('returns nothing at all without the week bounds, rather than guessing', () => {
    assert.deepEqual(weekRosterWindows({ weekStart: null, weekEnd: '2026-05-24' }), {});
    assert.deepEqual(weekRosterWindows({}), {});
    assert.deepEqual(weekRosterWindows(), {});
  });
});

describe('weekRosterWindows — the incidents', () => {
  // Juan Soto, added 5/22, was credited in PP1 Weeks 1 and 2. The manager field said he was theirs;
  // the dates said he was not yet.
  it('does not credit a week that ended before the add', () => {
    const w = weekRosterWindows({
      weekStart: '2026-05-04',
      weekEnd: '2026-05-10',
      mgrDates: { 'PP1|Week 3': { 'Juan Soto': { add_date: '2026-05-22' } } },
      rosterArray: { batters: ['Juan Soto'], pitchers: [] },
    });
    assert.equal(w['Juan Soto'], undefined);
  });

  // Yordan Alvarez, dropped 5/21, was credited in Week 4.
  it('does not credit a week that began after the drop', () => {
    const w = weekRosterWindows({
      weekStart: '2026-05-25',
      weekEnd: '2026-05-31',
      mgrDates: { 'PP1|Week 3': { 'Yordan Alvarez': { add_date: '2026-05-04', drop_date: '2026-05-21' } } },
      rosterArray: { batters: ['Yordan Alvarez'], pitchers: [] },
    });
    assert.equal(w['Yordan Alvarez'], undefined);
  });

  // Devers, added 5/9, silently stopped scoring the week AFTER he was added, because the roster
  // array for later weeks never carried him.
  it('carries a player forward into later weeks of the same period on his dates alone', () => {
    const w = weekRosterWindows({
      weekStart: '2026-05-11',
      weekEnd: '2026-05-17',
      mgrDates: { 'PP1|Week 1': { Devers: { add_date: '2026-05-09' } } },
      rosterArray: { batters: [], pitchers: [] },
    });
    assert.deepEqual(w.Devers, { start: '2026-05-11', end: '2026-05-17' });
  });

  // A new submission period starts fresh. A PP1 holdover with no drop is NOT a PP2 player, and the
  // DATES alone say so: his add is out of period, so it produces no window.
  it('does not leak a prior period holdover across the period boundary on the dates alone', () => {
    const args = {
      weekStart: '2026-06-08',
      weekEnd: '2026-06-14',
      mgrDates: { 'PP1|Week 1': { Holdover: { add_date: '2026-05-04' } } },
    };
    assert.equal(weekRosterWindows({ ...args, periodStart: '2026-06-08' }).Holdover, undefined);
    // …and with no period bound (PP1) the same player is still his.
    assert.ok(weekRosterWindows({ ...args, periodStart: null }).Holdover);
  });

  // KNOWN ASYMMETRY, extracted faithfully rather than fixed here. The roster-array fallback tests
  // latestAdd/latestDrop, which are PERIOD-SCOPED, so a holdover whose only date event is in a
  // prior period looks to it like a player with no dates at all — and the array puts him back.
  //
  // In practice the array should never contain him: auto-advance refuses to cross a period boundary
  // and rebuildRosterArraysFromDates re-derives from the dates, so the fallback firing here means a
  // data anomaly rather than a normal week. That is a claim about production data, not about this
  // function, so the shadow comparison measures it (`prior_period_via_array`) instead of this test
  // asserting a behaviour change nobody has vetted against the real season.
  it('DOES let the array fall back for a prior-period holdover — measured, not yet changed', () => {
    const w = weekRosterWindows({
      weekStart: '2026-06-08',
      weekEnd: '2026-06-14',
      periodStart: '2026-06-08',
      mgrDates: { 'PP1|Week 1': { Holdover: { add_date: '2026-05-04' } } },
      rosterArray: { batters: ['Holdover'], pitchers: [] },
    });
    assert.deepEqual(w.Holdover, { start: '2026-06-08', end: '2026-06-14' });
  });

  // A swap submitted on a week's LAST day takes effect tomorrow, so its add_date is next week's
  // first day — but the entry is filed under the week it was submitted in, and the incoming player
  // is already sitting in this week's roster array.
  it('does not let an effective-tomorrow add reach the roster-array fallback', () => {
    const w = weekRosterWindows({
      ...WEEK,
      mgrDates: { 'PP1|Week 3': { Incoming: { add_date: '2026-05-25' } } },
      rosterArray: { batters: ['Incoming'], pitchers: [] },
    });
    assert.equal(w.Incoming, undefined, 'a date that says "not yet" must beat the array cache');
  });

  // The mid-week handover: A drops on the 20th, B adds on the 21st. Each side gets only its days,
  // and the two windows do not overlap.
  it('splits a mid-week handover so neither manager is paid twice', () => {
    const outgoing = weekRosterWindows({
      ...WEEK,
      mgrDates: { w: { P: { add_date: '2026-05-04', drop_date: '2026-05-20' } } },
    });
    const incoming = weekRosterWindows({ ...WEEK, mgrDates: { w: { P: { add_date: '2026-05-21' } } } });
    assert.deepEqual(outgoing.P, { start: '2026-05-18', end: '2026-05-20' });
    assert.deepEqual(incoming.P, { start: '2026-05-21', end: '2026-05-24' });
    assert.ok(outgoing.P.end < incoming.P.start, 'the two windows must not overlap');
  });

  // A player dropped and later re-added inside the same period: the LATEST add wins.
  it('takes the latest add when a player was dropped and picked back up', () => {
    const w = weekRosterWindows({
      ...WEEK,
      mgrDates: {
        'PP1|Week 1': { P: { add_date: '2026-05-04', drop_date: '2026-05-12' } },
        'PP1|Week 3': { P: { add_date: '2026-05-20' } },
      },
    });
    assert.deepEqual(w.P, { start: '2026-05-20', end: '2026-05-24' });
  });

  it('reads the event that governs this week out of ANY week bucket', () => {
    // The bucket key is where a submission filed it, not which week it governs.
    const w = weekRosterWindows({ ...WEEK, mgrDates: { 'PP1|Week 1': { P: { drop_date: '2026-05-19' } } } });
    assert.deepEqual(w.P, { start: '2026-05-18', end: '2026-05-19' });
  });
});

describe('weekRosterWindows — the roster-array fallback is narrow on purpose', () => {
  it('covers an original-draft player with no date event anywhere', () => {
    const w = weekRosterWindows({ ...WEEK, mgrDates: {}, rosterArray: { batters: ['Drafted'], pitchers: [] } });
    assert.deepEqual(w.Drafted, { start: '2026-05-18', end: '2026-05-24' });
  });

  it('never resurrects a player his dates say was dropped', () => {
    const w = weekRosterWindows({
      ...WEEK,
      mgrDates: { 'PP1|Week 1': { Gone: { add_date: '2026-05-04', drop_date: '2026-05-12' } } },
      rosterArray: { batters: ['Gone'], pitchers: [] },
    });
    assert.equal(w.Gone, undefined, 'the additive array cache must never outrank a drop date');
  });

  it('covers pitchers as well as batters', () => {
    const w = weekRosterWindows({ ...WEEK, rosterArray: { batters: [], pitchers: ['Skubal'] } });
    assert.ok(w.Skubal);
  });
});

describe('windowAsDates', () => {
  it('expresses a week boundary as absent, which is what the scorer expects', () => {
    const full = windowAsDates({ start: '2026-05-18', end: '2026-05-24' }, WEEK.weekStart, WEEK.weekEnd);
    assert.deepEqual(full, { add_date: undefined, drop_date: undefined });
  });

  it('keeps an interior boundary', () => {
    assert.deepEqual(windowAsDates({ start: '2026-05-21', end: '2026-05-24' }, WEEK.weekStart, WEEK.weekEnd), {
      add_date: '2026-05-21',
      drop_date: undefined,
    });
    assert.deepEqual(windowAsDates({ start: '2026-05-18', end: '2026-05-20' }, WEEK.weekStart, WEEK.weekEnd), {
      add_date: undefined,
      drop_date: '2026-05-20',
    });
  });

  it('answers null for no window', () => {
    assert.equal(windowAsDates(null, WEEK.weekStart, WEEK.weekEnd), null);
  });
});

describe('dateInWindow / isFullWeek', () => {
  it('are inclusive at both ends', () => {
    const w = { start: '2026-05-20', end: '2026-05-22' };
    assert.equal(dateInWindow(w, '2026-05-20'), true);
    assert.equal(dateInWindow(w, '2026-05-22'), true);
    assert.equal(dateInWindow(w, '2026-05-19'), false);
    assert.equal(dateInWindow(w, '2026-05-23'), false);
  });

  it('answer false for nothing rather than throwing', () => {
    assert.equal(dateInWindow(null, '2026-05-20'), false);
    assert.equal(dateInWindow({ start: null, end: null }, null), false);
    assert.equal(isFullWeek(null, WEEK.weekStart, WEEK.weekEnd), false);
  });
});

describe('diffEligibility', () => {
  it('names the dangerous direction separately', () => {
    const d = diffEligibility({ A: {}, B: {} }, ['B', 'C']);
    assert.deepEqual(d.agree, ['B']);
    assert.deepEqual(d.claimed_only_by_windows, ['A']);
    assert.deepEqual(d.claimed_only_by_legacy, ['C']);
  });

  it('reports nothing when the two agree', () => {
    const d = diffEligibility({ A: {} }, ['A']);
    assert.deepEqual(d.claimed_only_by_windows, []);
    assert.deepEqual(d.claimed_only_by_legacy, []);
  });

  it('survives being handed nothing', () => {
    assert.deepEqual(diffEligibility(null, null), {
      agree: [],
      claimed_only_by_windows: [],
      claimed_only_by_legacy: [],
    });
  });
});
