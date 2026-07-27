// Date-window roster eligibility — the core WMMC scoring invariant, isolated as pure, tested
// functions so the rules that broke repeatedly in June 2026 (cross-period carry-forward, missing
// add dates, stale-array attribution) stay locked under `node --test`.
//
// THE INVARIANT: a player counts for a manager in a week ONLY while actually rostered — on/after
// their add date, on/before their drop date, and WITHIN the period (PP1/PP2/QF/SF/Finals). A new
// submission period starts fresh, so a prior period's add never carries across the boundary.
//
// CANONICAL SPEC. server.js (managerWeekSubtotal / rebuildRosterArraysFromDates) and app.js
// (managerWeekSubtotal, swap-form helpers) currently inline equivalent logic; the server can't
// import this ESM module, so those copies must be kept in sync with the rules verified here —
// same arrangement as SCORING / detectScoreSwings (see CLAUDE.md). Dates are ISO 'YYYY-MM-DD'
// strings, which compare correctly lexicographically.

// Start date of the PERIOD a round belongs to: the schedule start of that round's first week.
// Returns null for the initial period (the first round in the schedule) — there is no prior period
// to exclude, so the initial period's add/drop dates are never lower-bounded.
export function periodStartForRound(round, schedule, scheduleDates) {
  if (!round || !Array.isArray(schedule) || schedule.length === 0) return null;
  if (round === schedule[0].round) return null;
  for (let i = 0; i < schedule.length && i < (scheduleDates || []).length; i++) {
    if (schedule[i].round === round) return (scheduleDates[i] && scheduleDates[i].start) || null;
  }
  return null;
}

// Given a player's roster_dates entries (objects with optional add_date / drop_date) for ONE
// manager, decide whether the player is rostered as of `weekEnd`, scoped to the period:
//   - only add/drop dates on/after `periodStart` (when provided) are considered — this is what
//     stops a prior period's holdover from leaking into a new period;
//   - only dates on/before `weekEnd` (when provided) are considered;
//   - active when there is a qualifying add and no later qualifying drop.
export function isPlayerActiveAsOfWeekEnd(entries, { periodStart = null, weekEnd = null } = {}) {
  let latestAdd = null;
  let latestDrop = null;
  for (const d of entries || []) {
    if (!d) continue;
    if (
      d.add_date &&
      (!periodStart || d.add_date >= periodStart) &&
      (!weekEnd || d.add_date <= weekEnd) &&
      (!latestAdd || d.add_date > latestAdd)
    ) {
      latestAdd = d.add_date;
    }
    if (
      d.drop_date &&
      (!periodStart || d.drop_date >= periodStart) &&
      (!weekEnd || d.drop_date <= weekEnd) &&
      (!latestDrop || d.drop_date > latestDrop)
    ) {
      latestDrop = d.drop_date;
    }
  }
  return !!latestAdd && (!latestDrop || latestAdd > latestDrop);
}

// The rounds that knock managers out, in order. `sd.eliminated[manager]` holds the round a manager
// went out IN — 'PP' means they missed the playoff field entirely, 'QF' means they played the
// quarterfinals and lost, and so on. Pool play itself never restricts anyone: every manager is in
// PP1/PP2.
export const ELIMINATION_ROUND_ORDER = ['PP', 'QF', 'SF', 'Finals'];

// Is a manager eliminated in `eliminatedRound` still competing in schedule round `round`?
// A manager eliminated IN a round still PLAYED that round — 'QF' is out of SF and Finals, not QF.
// `eliminatedRound` is null/undefined for a manager who was never eliminated. An unrecognized
// round on either side returns true: never hide a manager on the strength of data we can't read.
export function isManagerActiveInRound(round, eliminatedRound) {
  if (!round || round === 'PP1' || round === 'PP2') return true;
  if (!eliminatedRound) return true;
  const elimIdx = ELIMINATION_ROUND_ORDER.indexOf(eliminatedRound);
  const roundIdx = ELIMINATION_ROUND_ORDER.indexOf(round);
  if (elimIdx < 0 || roundIdx < 0) return true;
  return elimIdx >= roundIdx;
}

// Whether `manager` is still in the competition for schedule round `round` — the guard that keeps
// an eliminated manager from being shown as the owner of a player in a round they aren't playing.
// Sources, most authoritative first:
//   1. `participants` — the round's actual bracket field (QF/SF/Finals). When known, it is the
//      whole truth: anyone not in it is out.
//   2. `eliminated` — the sd.eliminated map, covering the window before a bracket is derivable.
// Pool play, an unknown round, and "nothing known yet" all return true, so a missing bracket can
// never hide a legitimately active manager.
export function isManagerInRound(manager, round, { participants = null, eliminated = null } = {}) {
  if (!round || round === 'PP1' || round === 'PP2') return true;
  const field = (participants || []).filter((n) => typeof n === 'string' && n);
  if (field.length) return field.includes(manager);
  return isManagerActiveInRound(round, (eliminated || {})[manager]);
}

// Whether a single game on `gameDate` falls within a player's effective scoring window for a week,
// honoring an optional per-player add/drop override and the week's calendar [weekStart, weekEnd].
// Mirrors isDateEligibleForPlayer / computeEffective* in server.js: an add/drop override replaces
// the corresponding calendar bound (inclusive on both ends).
export function isGameDateEligible(
  gameDate,
  { weekStart = null, weekEnd = null, addDate = null, dropDate = null } = {}
) {
  const start = addDate != null ? addDate : weekStart;
  const end = dropDate != null ? dropDate : weekEnd;
  if (start && gameDate < start) return false;
  if (end && gameDate > end) return false;
  return true;
}
