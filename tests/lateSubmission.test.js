import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATE_FALLBACK_FIRST_PITCH_HOUR_ET,
  addDaysISO,
  periodBounds,
  nextViableEffectiveDate,
  validateForgivenessDate,
  dayHasStartedFallback,
  isSubmissionLate,
  submissionLateState,
  lateSubmissionActions,
} from '../js/lateSubmission.js';

// A two-week Finals period running Mon Aug 17 through Sun Aug 30, 2026 — the shape of the
// situation this feature was built for.
const SCHEDULE = [
  { round: 'SF', week: 'Week 1' },
  { round: 'SF', week: 'Week 2' },
  { round: 'Finals', week: 'Week 1' },
  { round: 'Finals', week: 'Week 2' },
];
const DATES = [
  { start: '2026-08-03', end: '2026-08-09' },
  { start: '2026-08-10', end: '2026-08-16' },
  { start: '2026-08-17', end: '2026-08-23' },
  { start: '2026-08-24', end: '2026-08-30' },
];

describe('addDaysISO', () => {
  it('advances a day', () => {
    assert.equal(addDaysISO('2026-08-19', 1), '2026-08-20');
  });

  it('rolls over a month boundary', () => {
    assert.equal(addDaysISO('2026-08-31', 1), '2026-09-01');
  });

  it('rolls over a year boundary', () => {
    assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  });

  it('goes backwards too', () => {
    assert.equal(addDaysISO('2026-03-01', -1), '2026-02-28');
  });

  it('returns null for a missing or unparseable date', () => {
    assert.equal(addDaysISO(null, 1), null);
    assert.equal(addDaysISO('not-a-date', 1), null);
  });
});

describe('periodBounds', () => {
  it('spans a period from its first week start to its last week end', () => {
    assert.deepEqual(periodBounds('Finals', SCHEDULE, DATES), {
      start: '2026-08-17',
      end: '2026-08-30',
      firstWeekKey: 'Finals|Week 1',
    });
  });

  it('names the first week key, which is where the submission stamps its add dates', () => {
    assert.equal(periodBounds('SF', SCHEDULE, DATES).firstWeekKey, 'SF|Week 1');
  });

  it('returns null for a round the schedule does not cover', () => {
    assert.equal(periodBounds('QF', SCHEDULE, DATES), null);
  });

  it('returns null when the schedule dates run short of the round', () => {
    assert.equal(periodBounds('Finals', SCHEDULE, DATES.slice(0, 2)), null);
  });
});

describe('nextViableEffectiveDate', () => {
  const finals = { periodStart: '2026-08-17', periodEnd: '2026-08-30' };

  it('takes effect TOMORROW when the day’s games have already started', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-19', dayHasStarted: true }), '2026-08-20');
  });

  it('takes effect TODAY when the day’s games have not started yet', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-19', dayHasStarted: false }), '2026-08-19');
  });

  it('takes effect Tuesday for a roster submitted after Monday’s first pitch', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-17', dayHasStarted: true }), '2026-08-18');
  });

  it('never starts before the period does, even submitted days early', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-14', dayHasStarted: true }), '2026-08-17');
  });

  it('returns null once the period is over — no viable day is left', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-31', dayHasStarted: false }), null);
  });

  it('returns null when the last day of the period has already begun', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-30', dayHasStarted: true }), null);
  });

  it('still allows the final day of the period before its first pitch', () => {
    assert.equal(nextViableEffectiveDate({ ...finals, todayET: '2026-08-30', dayHasStarted: false }), '2026-08-30');
  });

  it('is unbounded on the end when the period has no known end date', () => {
    assert.equal(
      nextViableEffectiveDate({ periodStart: '2026-08-17', todayET: '2026-09-05', dayHasStarted: true }),
      '2026-09-06'
    );
  });

  it('returns null without a period start — an unbounded add date corrupts scoring', () => {
    assert.equal(nextViableEffectiveDate({ periodStart: null, todayET: '2026-08-19' }), null);
  });
});

describe('validateForgivenessDate', () => {
  it('accepts the first day of the period — a full back-date', () => {
    assert.deepEqual(validateForgivenessDate('2026-08-17', '2026-08-17', '2026-08-30'), {
      ok: true,
      effective_date: '2026-08-17',
    });
  });

  it('accepts a day in the middle of the period', () => {
    assert.equal(validateForgivenessDate('2026-08-20', '2026-08-17', '2026-08-30').ok, true);
  });

  it('rejects a date before the period starts', () => {
    const r = validateForgivenessDate('2026-08-16', '2026-08-17', '2026-08-30');
    assert.equal(r.ok, false);
    assert.match(r.error, /before the period starts/);
  });

  it('rejects a date after the period ends', () => {
    const r = validateForgivenessDate('2026-08-31', '2026-08-17', '2026-08-30');
    assert.equal(r.ok, false);
    assert.match(r.error, /after the period ends/);
  });

  it('rejects a malformed date rather than guessing at it', () => {
    assert.equal(validateForgivenessDate('8/17/2026', '2026-08-17', '2026-08-30').ok, false);
    assert.equal(validateForgivenessDate(null, '2026-08-17', '2026-08-30').ok, false);
  });

  it('refuses when the period has no start date on the schedule', () => {
    const r = validateForgivenessDate('2026-08-17', null, null);
    assert.equal(r.ok, false);
    assert.match(r.error, /no start date/);
  });
});

describe('dayHasStartedFallback', () => {
  it('reads the morning as not yet started', () => {
    assert.equal(dayHasStartedFallback(9), false);
  });

  it('reads the cutoff hour itself as started', () => {
    assert.equal(dayHasStartedFallback(LATE_FALLBACK_FIRST_PITCH_HOUR_ET), true);
  });

  it('reads the evening as started', () => {
    assert.equal(dayHasStartedFallback(20), true);
  });

  it('errs early enough to cover an 11am holiday first pitch', () => {
    assert.ok(LATE_FALLBACK_FIRST_PITCH_HOUR_ET <= 11);
  });

  it('treats an unknown hour as not started', () => {
    assert.equal(dayHasStartedFallback(NaN), false);
  });
});

describe('isSubmissionLate', () => {
  it('is late at the deadline instant', () => {
    assert.equal(isSubmissionLate(1000, 1000), true);
  });

  it('is not late a moment before', () => {
    assert.equal(isSubmissionLate(1000, 999), false);
  });

  it('is never late when no deadline is configured', () => {
    assert.equal(isSubmissionLate(null, 5000), false);
  });
});

describe('submissionLateState', () => {
  it('reads a record written before this feature existed as not late', () => {
    assert.deepEqual(submissionLateState({ batters: [], pitchers: [], status: 'approved' }), {
      late: false,
      effectiveDate: null,
      forgiveness: null,
      forgivenessPending: false,
      forgivenessGranted: false,
      reason: null,
      autoEffectiveDate: null,
    });
  });

  it('tolerates a missing record entirely', () => {
    assert.equal(submissionLateState(undefined).late, false);
  });

  it('surfaces a pending forgiveness request with its plea', () => {
    const s = submissionLateState({
      late: true,
      effective_date: null,
      auto_effective_date: '2026-08-20',
      forgiveness_status: 'pending',
      forgiveness_reason: 'Was on a plane all Monday.',
    });
    assert.equal(s.late, true);
    assert.equal(s.forgivenessPending, true);
    assert.equal(s.autoEffectiveDate, '2026-08-20');
    assert.equal(s.reason, 'Was on a plane all Monday.');
  });

  it('surfaces a granted back-date', () => {
    const s = submissionLateState({
      late: true,
      effective_date: '2026-08-17',
      auto_effective_date: '2026-08-20',
      forgiveness_status: 'granted',
    });
    assert.equal(s.forgivenessGranted, true);
    assert.equal(s.effectiveDate, '2026-08-17');
  });

  it('ignores a forgiveness status it does not recognize', () => {
    assert.equal(submissionLateState({ forgiveness_status: 'maybe' }).forgiveness, null);
  });
});

describe('lateSubmissionActions', () => {
  const complete = { isLate: true, rosterComplete: true, effectiveDate: '2026-08-20' };

  it('offers both Submit and Beg to a late manager with a full roster', () => {
    assert.deepEqual(lateSubmissionActions(complete), { canSubmit: true, canBeg: true, reason: null });
  });

  it('offers nothing while the window is still open — the normal path applies', () => {
    assert.deepEqual(lateSubmissionActions({ ...complete, isLate: false }), {
      canSubmit: false,
      canBeg: false,
      reason: null,
    });
  });

  it('offers nothing once the roster is approved', () => {
    assert.equal(lateSubmissionActions({ ...complete, hasApproved: true }).canBeg, false);
  });

  it('locks both buttons while a forgiveness request is with the commissioner', () => {
    assert.deepEqual(lateSubmissionActions({ ...complete, forgiveness: 'pending' }), {
      canSubmit: false,
      canBeg: false,
      reason: 'awaiting_forgiveness',
    });
  });

  it('re-opens both buttons after forgiveness is denied — the roster still lands, just later', () => {
    assert.deepEqual(lateSubmissionActions({ ...complete, forgiveness: 'denied' }), {
      canSubmit: true,
      canBeg: true,
      reason: null,
    });
  });

  it('withholds Submit but keeps Beg once the period is over', () => {
    assert.deepEqual(lateSubmissionActions({ ...complete, effectiveDate: null }), {
      canSubmit: false,
      canBeg: true,
      reason: 'period_over',
    });
  });

  it('withholds both on an incomplete roster', () => {
    assert.deepEqual(lateSubmissionActions({ ...complete, rosterComplete: false }), {
      canSubmit: false,
      canBeg: false,
      reason: null,
    });
  });
});
