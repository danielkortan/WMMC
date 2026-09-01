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

// Week keys ("<round>|<week>") belonging to the SAME period as `round`, in schedule order.
// The per-week roster ARRAYS are a derived cache, so any code that falls back to them must limit
// itself to these keys: a manager eliminated in an earlier round still has that round's roster
// array on file, and reading it as a live roster is what the period scoping exists to prevent.
export function periodWeekKeys(round, schedule) {
  if (!round || !Array.isArray(schedule)) return [];
  return schedule.filter((s) => s.round === round).map((s) => `${s.round}|${s.week}`);
}

// Roster status of `player` for ONE manager, as of `asOf`, scoped to a single period — the
// question every "who holds this player right now" view asks (swap form Player Out / available
// pool). Returns the same four states as rosterStatusAsOf.
//
// `rosterDates` is that manager's roster_dates ({ weekKey: { player: {add_date, drop_date} } })
// and is the SOURCE OF TRUTH. `rosters` (that manager's { weekKey: {batters, pitchers} }) is a
// derived cache and is consulted ONLY when the player has no date events inside the period, and
// only for `weekKeys` — the period's own weeks. Without that restriction the fallback reaches
// back into a prior period: a manager knocked out in the QF keeps their QF roster array, so every
// player on it reads as still-held and can never be swapped in by the managers still playing.
export function rosterStatusForManager(
  player,
  { rosterDates = null, rosters = null, periodStart = null, asOf = null, weekKeys = null } = {}
) {
  const entries = [];
  for (const weekDates of Object.values(rosterDates || {})) {
    if (weekDates && weekDates[player]) entries.push(weekDates[player]);
  }
  const status = rosterStatusAsOf(entries, { periodStart, asOf });
  if (status !== 'none') return status;
  const latest = (weekKeys || []).filter((wk) => (rosters || {})[wk]).pop();
  if (!latest) return 'none';
  const wr = rosters[latest] || {};
  return (wr.batters || []).includes(player) || (wr.pitchers || []).includes(player) ? 'active' : 'none';
}

// The slice of a week a player was rostered by ONE manager, from that manager's roster_dates entry
// for that week. Returns null when the manager held him for the WHOLE week (no add after the week
// started, no drop before it ended) — the common case, where the stored weekly_score already is
// this manager's score and nothing needs clipping. Otherwise returns the bounds that do apply:
// `{ start, end }`, either side null when that side is the week's own boundary. Both bounds are
// INCLUSIVE: add_date is the first day he scores for this manager, drop_date the last.
export function managerWeekWindow(dates, { weekStart = null, weekEnd = null } = {}) {
  if (!dates) return null;
  const start = dates.add_date && (!weekStart || dates.add_date > weekStart) ? dates.add_date : null;
  const end = dates.drop_date && (!weekEnd || dates.drop_date < weekEnd) ? dates.drop_date : null;
  return start || end ? { start, end } : null;
}

// Widest window covering every manager's claim on ONE player in ONE week — the merge that keeps a
// mid-week handover from erasing points. A player can change hands inside a week (a trade: dropped
// by A on the 28th, added by B on the 29th), but a week's per-player scoring window is stored once
// per player, not once per owner. Taking the last claim written would drop the other side of the
// handover — and, since nothing orders those writes, non-deterministically. The union keeps every
// day SOMEBODY rostered him; splitting those days back out per manager is managerWeekWindow's job.
//
// `windows` are `{ start, end }` objects (null = that side is unbounded) or null for a claim that
// spans the whole week. Returns null when any claim is unbounded on both sides, or when there are
// none — in both cases the week's own calendar bounds are the right window and no override applies.
export function mergeWeekWindows(windows) {
  let start;
  let end;
  let any = false;
  for (const w of windows || []) {
    if (!w) return null; // a whole-week claim swallows every narrower one
    any = true;
    // An unbounded side wins: if any owner had no cutoff there, the merged window has none either.
    start = start === undefined ? w.start : start === null || w.start === null ? null : minDate(start, w.start);
    end = end === undefined ? w.end : end === null || w.end === null ? null : maxDate(end, w.end);
  }
  if (!any || (!start && !end)) return null;
  return { start: start || null, end: end || null };
}

const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);

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

// The rounds that knock managers out, in order. `sd.eliminated[manager]` holds the round a manager
// went out IN — 'PP' means they missed the playoff field entirely, 'QF' means they played the
// quarterfinals and lost, and so on. Pool play itself never restricts anyone: every manager is in
// PP1/PP2.
export const ELIMINATION_ROUND_ORDER = ['PP', 'QF', 'SF', 'Finals'];

// The LAST schedule round a manager still plays, given the round they lost in.
//
// For every round but one this is that round itself. The SEMIFINAL is the exception, and it is
// the whole reason this helper exists: losing a semifinal knocks nobody out of the schedule.
// The two SF losers play the 3rd-place game, and the 3rd-place game is contested over the
// FINALS weeks (see SEASON_SCHEDULE: 'Finals / 3rd Place - Week 1' and 'Week 2'). So all four
// semifinalists are active in the Finals round — two in the Championship, two in the 3rd-place
// game — and all four submit a Finals-period roster.
//
// Applied on READ rather than by rewriting stored values, so the seasons written before this fix
// (where "Advance winners" did stamp sd.eliminated[loser] = 'SF') behave correctly too.
export function lastRoundPlayed(eliminatedRound) {
  return eliminatedRound === 'SF' ? 'Finals' : eliminatedRound;
}

// Is a manager eliminated in `eliminatedRound` still competing in schedule round `round`?
// A manager eliminated IN a round still PLAYED that round — 'QF' is out of SF and Finals, not QF.
// `eliminatedRound` is null/undefined for a manager who was never eliminated. An unrecognized
// round on either side returns true: never hide a manager on the strength of data we can't read.
export function isManagerActiveInRound(round, eliminatedRound) {
  if (!round || round === 'PP1' || round === 'PP2') return true;
  if (!eliminatedRound) return true;
  const elimIdx = ELIMINATION_ROUND_ORDER.indexOf(lastRoundPlayed(eliminatedRound));
  const roundIdx = ELIMINATION_ROUND_ORDER.indexOf(round);
  if (elimIdx < 0 || roundIdx < 0) return true;
  return elimIdx >= roundIdx;
}

// Whether `manager` is still in the competition for schedule round `round` — the guard that keeps
// an eliminated manager from being listed as a 0-point ghost row, or shown as the owner of a
// player, in a round they aren't playing. Sources, most authoritative first:
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

// ---- Which Finals-week game a manager is actually playing ----
//
// The Finals period is TWO games run over the SAME two weeks: the Championship between the
// semifinal winners, and the 3rd-place game between the semifinal losers. All four semifinalists
// submit a roster for it (see lastRoundPlayed), which is why every submission surface calls that
// period "Finals" — and why two of those four managers are told, on every card and every banner,
// to submit for a game they are not in.
//
// Given the round's field, name the game the manager is in. When the semifinal isn't finalized
// yet the field isn't known, and the honest answer is both games at once — never a guess, because
// guessing here tells a manager he's in the Championship.
export const FINALS_GAME_LABELS = {
  finals: 'Finals',
  third: '3rd Place Game',
  unknown: 'Finals / 3rd Place',
};

// 'finals' | 'third' | null (unknown). `finalists` are the SF winners, `semifinalists` all four.
export function finalsGameFor(manager, { finalists = null, semifinalists = null } = {}) {
  if (!manager) return null;
  const fin = (finalists || []).filter((n) => typeof n === 'string' && n);
  if (fin.includes(manager)) return 'finals';
  const sf = (semifinalists || []).filter((n) => typeof n === 'string' && n);
  if (fin.length && sf.includes(manager)) return 'third';
  return null;
}

// The label to print for that manager's Finals-period submission.
export function finalsGameLabel(manager, field = {}) {
  return FINALS_GAME_LABELS[finalsGameFor(manager, field) || 'unknown'];
}
