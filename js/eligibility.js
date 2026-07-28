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

// Roster status of a player AS OF a specific date, from that player's roster_dates entries for ONE
// manager. Where isPlayerActiveAsOfWeekEnd answers a yes/no question at a week boundary, this
// answers the three-state question every roster VIEW needs:
//   'active'    — an add on/before `asOf` with no later drop: rostered right now, still scoring
//   'dropped'   — a drop on/before `asOf` that supersedes the latest add
//   'scheduled' — nothing has taken effect yet, but a future-dated add exists
//   'none'      — no dates for this player in this period
//
// A SCHEDULED swap is recorded the moment it is submitted, so the outgoing player's drop_date and
// the incoming player's add_date both sit in the FUTURE. Evaluating as of today is what keeps such
// a swap from reading as already applied: the outgoing player stays 'active' (and keeps scoring)
// until their drop date, and the incoming player reads 'scheduled' until their add date. Passing
// `asOf: null` (or a date past every window) collapses this back to a plain past-tense reading.
export function rosterStatusAsOf(entries, { periodStart = null, asOf = null } = {}) {
  let latestAdd = null;
  let latestDrop = null;
  let nextAdd = null; // earliest add still in the future
  let nextDrop = null; // earliest drop still in the future
  for (const d of entries || []) {
    if (!d) continue;
    if (d.add_date && (!periodStart || d.add_date >= periodStart)) {
      if (asOf && d.add_date > asOf) {
        if (!nextAdd || d.add_date < nextAdd) nextAdd = d.add_date;
      } else if (!latestAdd || d.add_date > latestAdd) {
        latestAdd = d.add_date;
      }
    }
    if (d.drop_date && (!periodStart || d.drop_date >= periodStart)) {
      if (asOf && d.drop_date > asOf) {
        if (!nextDrop || d.drop_date < nextDrop) nextDrop = d.drop_date;
      } else if (!latestDrop || d.drop_date > latestDrop) {
        latestDrop = d.drop_date;
      }
    }
  }
  if (latestAdd && (!latestDrop || latestAdd > latestDrop)) return 'active';
  if (latestDrop) return 'dropped';
  // Nothing has taken effect yet. A pending drop implies the player is rostered right now (you
  // cannot drop a player you don't have) — that covers an initial/period submission player, who
  // has no add_date of their own. A pending add alone means they are not on the roster yet.
  if (nextDrop && (!nextAdd || nextDrop < nextAdd)) return 'active';
  if (nextAdd) return 'scheduled';
  return 'none';
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
