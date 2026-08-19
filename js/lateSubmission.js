// Late roster submissions — the rules that decide WHEN a roster submitted after its period's
// lock actually takes effect, isolated as pure functions so they can be unit-tested and mirrored
// into server.js (which cannot import an ES module). See CLAUDE.md's "edit both copies" rule;
// tests/serverMirrors.test.js mechanizes it for this file.
//
// THE RULE. A period's roster is due before that period's first pitch. Missing the deadline no
// longer removes the submission form — it moves the roster's start date forward instead:
//
//   - Submit before the day's first pitch  -> the roster takes effect TODAY.
//   - Submit after the day's first pitch   -> the roster takes effect TOMORROW.
//   - Either way, never before the period starts, and never after it ends.
//
// That is the whole point: a late manager still gets to play, but he can never look at a
// finished box score and then buy into it. The effective date becomes the players' `add_date`
// at approval, which is the core scoring invariant's own unit — so the rest of the app needs no
// special case for a late roster. It simply scores a shorter window.
//
// Dates are ISO 'YYYY-MM-DD' strings throughout, which compare correctly lexicographically.

// Fallback first-pitch hour (ET, 24h) used ONLY when the MLB schedule can't be reached. The
// earliest games on a normal slate are around 12:05 PM ET, with the odd holiday start at 11:10 AM,
// so 11 is early enough that the fallback errs toward "the day has started" — i.e. toward pushing
// the roster to tomorrow. Failing that way costs a late manager part of a day; failing the other
// way would let him claim a game already in the books.
export const LATE_FALLBACK_FIRST_PITCH_HOUR_ET = 11;

// The three states a "Beg Commish for Forgiveness" request can be in. A request that is DENIED
// is not thrown away — the roster still lands, it just lands on the automatic next-viable date
// instead of the back-date the manager asked for.
export const FORGIVENESS_STATES = ['pending', 'granted', 'denied'];

// ISO date shifted by whole days, done in UTC so a server running in any zone can't slide the
// calendar day underneath it.
export function addDaysISO(iso, days) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// First and last calendar day of a period, read off the season's own schedule_dates by round.
// Returns null when the schedule doesn't cover the round — callers must treat that as "unknown"
// rather than "unbounded", because an unbounded window is how add/drop scoring gets corrupted.
export function periodBounds(round, schedule, scheduleDates) {
  if (!round || !Array.isArray(schedule) || !Array.isArray(scheduleDates)) return null;
  let start = null;
  let end = null;
  let firstWeekKey = null;
  for (let i = 0; i < schedule.length && i < scheduleDates.length; i++) {
    if (schedule[i].round !== round) continue;
    const dates = scheduleDates[i];
    if (!dates) continue;
    if (start === null && dates.start) {
      start = dates.start;
      firstWeekKey = `${schedule[i].round}|${schedule[i].week}`;
    }
    if (dates.end) end = dates.end;
  }
  return start ? { start, end: end || null, firstWeekKey } : null;
}

// The date a submission made "now" should take effect. `dayHasStarted` is whether today's MLB
// slate has already begun (the server answers that from the real schedule; see the fallback
// helper below for when it can't).
//
// Returns null when there is no viable day left — the period has already ended, so nothing a
// manager submits now can score, and only a commissioner back-date can salvage it.
export function nextViableEffectiveDate({ periodStart, periodEnd = null, todayET, dayHasStarted = false }) {
  if (!periodStart || !todayET) return null;
  // The period hasn't started yet: this isn't late at all, and the roster starts with the period.
  if (todayET < periodStart) return periodStart;
  const candidate = dayHasStarted ? addDaysISO(todayET, 1) : todayET;
  if (!candidate) return null;
  const effective = candidate < periodStart ? periodStart : candidate;
  if (periodEnd && effective > periodEnd) return null;
  return effective;
}

// A commissioner-chosen effective date, held inside the period. Back-dating is the entire
// privilege being granted here, so any day of the period is allowed — including its first, which
// makes the late roster score exactly as if it had been in on time. Anything outside the period
// is rejected rather than silently clamped: a date the commissioner didn't mean is worse than an
// error he can see.
export function validateForgivenessDate(dateISO, periodStart, periodEnd) {
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return { ok: false, error: 'effective_date must be an ISO YYYY-MM-DD date' };
  }
  if (!periodStart) return { ok: false, error: 'This period has no start date in the schedule yet' };
  if (dateISO < periodStart) {
    return { ok: false, error: `Effective date cannot be before the period starts (${periodStart})` };
  }
  if (periodEnd && dateISO > periodEnd) {
    return { ok: false, error: `Effective date cannot be after the period ends (${periodEnd})` };
  }
  return { ok: true, effective_date: dateISO };
}

// Has today's slate already begun, when the MLB schedule could NOT be consulted? `etHour` is the
// current hour in America/New_York on a 24-hour clock. See the constant above for why this
// deliberately reads early.
export function dayHasStartedFallback(etHour, cutoffHour = LATE_FALLBACK_FIRST_PITCH_HOUR_ET) {
  return Number.isFinite(etHour) && etHour >= cutoffHour;
}

// Is a submission arriving now past its period's lock? `deadlineMs` is the lock instant (first
// pitch − 5 minutes); a season with no configured deadline can't be late, because there is no
// published time to have missed.
export function isSubmissionLate(deadlineMs, nowMs) {
  return Number.isFinite(deadlineMs) && Number.isFinite(nowMs) && nowMs >= deadlineMs;
}

// The late/forgiveness facts carried on a stored submission record, normalized so the manager
// card, the commissioner queue, the status table and the server all read one shape rather than
// each poking at raw fields. Tolerates a record written before this feature existed (everything
// reads false/null), which is what makes it safe on an in-flight season.
export function submissionLateState(sub) {
  const s = sub || {};
  const forgiveness = FORGIVENESS_STATES.includes(s.forgiveness_status) ? s.forgiveness_status : null;
  return {
    late: !!s.late,
    effectiveDate: s.effective_date || null,
    forgiveness,
    forgivenessPending: forgiveness === 'pending',
    forgivenessGranted: forgiveness === 'granted',
    reason: s.forgiveness_reason || null,
    // What the automatic rule offered at submission time. Kept alongside a granted back-date so
    // the audit trail shows what the forgiveness was actually worth.
    autoEffectiveDate: s.auto_effective_date || null,
  };
}

// What a manager may do with a period whose lock has passed. Split out from the rendering so the
// rule — rather than the markup — is what the tests pin down.
//
//   canSubmit  — take the automatic effective date and get on with it.
//   canBeg     — ask the commissioner for a back-date instead.
//
// A manager whose roster is already approved has nothing to do here. A pending forgiveness
// request locks both buttons: it is with the commissioner, and letting the manager keep
// resubmitting underneath a decision he asked for is how two rosters end up half-applied.
export function lateSubmissionActions({
  isLate = false,
  hasApproved = false,
  forgiveness = null,
  effectiveDate = null,
  rosterComplete = false,
} = {}) {
  if (!isLate || hasApproved) return { canSubmit: false, canBeg: false, reason: null };
  if (forgiveness === 'pending') {
    return { canSubmit: false, canBeg: false, reason: 'awaiting_forgiveness' };
  }
  return {
    // With no viable day left, a plain submit would score nothing — only a back-date can help.
    canSubmit: !!effectiveDate && rosterComplete,
    canBeg: rosterComplete,
    reason: effectiveDate ? null : 'period_over',
  };
}
