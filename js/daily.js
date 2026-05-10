// ============================================================
// Daily Stats Logic (shared between server and tests)
// ============================================================

import { calculateBattingScore, calculatePitchingScore } from './scoring.js';
import { SEASON_SCHEDULE } from './state.js';

// Convert IP from baseball notation to true decimal.
// "6.1" = 6 + 1/3 ≈ 6.333, "7.2" = 7 + 2/3 ≈ 7.667
export function convertIPDecimal(rawIP) {
  const str = String(rawIP);
  const dot = str.indexOf('.');
  if (dot === -1) return parseFloat(rawIP) || 0;
  const whole = parseInt(str.slice(0, dot)) || 0;
  const frac = str.slice(dot + 1);
  if (frac === '1') return Math.round((whole + 1 / 3) * 1000) / 1000;
  if (frac === '2') return Math.round((whole + 2 / 3) * 1000) / 1000;
  return parseFloat(rawIP) || 0;
}

// Daily delta between two batting cumulative snapshots (floor at 0 to guard week resets).
export function battingDelta(curr, prev) {
  const fields = ['1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb', 'abs'];
  const delta = {};
  for (const f of fields) delta[f] = Math.max(0, (curr[f] || 0) - (prev[f] || 0));
  return delta;
}

// Daily delta between two pitching cumulative snapshots (IP in decimal).
export function pitchingDelta(curr, prev) {
  const intFields = ['gs', 'w', 'qs', 'cg', 'cgso', 'nh', 'h', 'er', 'bb', 'k'];
  const delta = {};
  for (const f of intFields) delta[f] = Math.max(0, (curr[f] || 0) - (prev[f] || 0));
  delta.ip = Math.max(0, Math.round(((curr.ip || 0) - (prev.ip || 0)) * 1000) / 1000);
  return delta;
}

// Find the SEASON_SCHEDULE index for a given round+week.
export function getScheduleWeekIndex(round, week) {
  return SEASON_SCHEDULE.findIndex(s => s.round === round && s.week === week);
}

// Add one calendar day to a YYYY-MM-DD string.
function addOneDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

// Compute the effective weekly batting score from daily deltas, respecting player_dates.
// Returns null when no daily records exist (caller should fall back to stored weekly_score).
export function computeEffectiveBattingScore(sd, batter, round, week) {
  const records = (sd.daily_batting || []).filter(r =>
    r.batter === batter && r.round === round && r.week === week
  );
  if (records.length === 0) return null;

  const weekIdx = getScheduleWeekIndex(round, week);
  const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;
  const weekKey = `${round}|${week}`;
  const override = (((sd.player_dates || {})[weekKey] || {}).batter || {})[batter] || {};

  const effectiveStart = ('start' in override) ? override.start : (weekDates && weekDates.start) || null;
  // Shift end by +1 day: the daily sync runs in the morning and creates a record dated
  // today containing yesterday's games. The last day of the scoring week therefore
  // appears in a record dated end+1, so we must include it.
  const rawEnd = ('end' in override) ? override.end : (weekDates && weekDates.end) || null;
  const effectiveEnd = rawEnd ? addOneDay(rawEnd) : null;

  const eligible = records.filter(r => {
    if (effectiveStart && r.date < effectiveStart) return false;
    if (effectiveEnd && r.date > effectiveEnd) return false;
    return true;
  });

  return Math.round(eligible.reduce((sum, r) => sum + calculateBattingScore(r.delta || {}), 0) * 100) / 100;
}

// Compute the effective weekly pitching score from daily deltas, respecting player_dates.
export function computeEffectivePitchingScore(sd, pitcher, round, week) {
  const records = (sd.daily_pitching || []).filter(r =>
    r.pitcher === pitcher && r.round === round && r.week === week
  );
  if (records.length === 0) return null;

  const weekIdx = getScheduleWeekIndex(round, week);
  const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;
  const weekKey = `${round}|${week}`;
  const override = (((sd.player_dates || {})[weekKey] || {}).pitcher || {})[pitcher] || {};

  const effectiveStart = ('start' in override) ? override.start : (weekDates && weekDates.start) || null;
  const rawEnd = ('end' in override) ? override.end : (weekDates && weekDates.end) || null;
  const effectiveEnd = rawEnd ? addOneDay(rawEnd) : null;

  const eligible = records.filter(r => {
    if (effectiveStart && r.date < effectiveStart) return false;
    if (effectiveEnd && r.date > effectiveEnd) return false;
    return true;
  });

  return Math.round(eligible.reduce((sum, r) => sum + calculatePitchingScore(r.delta || {}), 0) * 100) / 100;
}

// Recompute all weekly scores from daily data after player_dates or manual stat changes.
// Skips records that have manual_fields or drop_locked (commissioner overrides stay intact).
export function recomputeAllWeeklyScores(sd) {
  (sd.weekly_batting || []).forEach(b => {
    if ((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked) return;
    const score = computeEffectiveBattingScore(sd, b.batter, b.round, b.week);
    if (score !== null) { b.weekly_score = score; b.total_score = score; }
  });
  (sd.weekly_pitching || []).forEach(p => {
    if ((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked) return;
    const score = computeEffectivePitchingScore(sd, p.pitcher, p.round, p.week);
    if (score !== null) { p.weekly_score = score; }
  });
}
