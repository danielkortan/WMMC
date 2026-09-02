// ============================================================
// WMMC — Who a manager held, and for which days of a week
// ============================================================
// The core scoring invariant says a manager scores a player only inside that player's
// add_date → drop_date window, scoped to the period. This module is that sentence as code, and it
// is the answer everything else should be reading.
//
// It exists because the app currently has TWO derivations of it. managerWeekSubtotal (server.js)
// builds an `eligible` SET by unioning five heuristics — the roster array filtered by a
// "was he dropped earlier" scan, a period-scoped carry-forward, this week's own date bucket, and
// the approved swaps whose week_key matches — and then decides per stat row which manager may claim
// it. managerWeekRosterWindows builds a per-player WINDOW from roster_dates alone, with the roster
// array as an explicit fallback only for a player who has no date events at all.
//
// Forty-three of the ninety-eight entries in MEMORY.md are the same structural bug: the two
// disagree, and whichever one a given surface happened to call is what that surface showed. The
// windows form is the one that matches the invariant, so the plan (SEASON_ONE_REVIEW.md R1) is to
// make the subtotal a thin consumer of it. This module is the first half of that: the derivation,
// extracted, pure, and unit-tested against the season's real incidents.
//
// PURE — it takes already-derived facts (the week's bounds, the period start, one manager's date
// buckets, one week's roster array) rather than a season object, so it can be tested without one
// and cannot reach for a second source of truth by accident.
//
// Canonical copy. Mirrored verbatim in server.js and guarded by tests/serverMirrors.test.js.

// One manager's windows for one week.
//
//   weekStart / weekEnd  the week's bounds, inclusive
//   periodStart          the first day of this round's submission period, or null for PP1. A new
//                        period starts fresh from its own submission, so an add or drop from a
//                        PRIOR period must not carry into this one.
//   mgrDates             sd.roster_dates[manager] — every week bucket, because the event that
//                        governs this week is routinely filed under another one
//   rosterArray          { batters, pitchers } for this week, the additive derived cache
//
// Returns { player: { start, end } } — absolute dates, already clipped to the week. A player who
// was not this manager's during the week is absent, which is the difference between this and a set:
// the caller never has to ask a second question about how much of the week to count.
export function weekRosterWindows({ weekStart, weekEnd, periodStart = null, mgrDates = {}, rosterArray = {} } = {}) {
  if (!weekStart || !weekEnd) return {};

  const latestAdd = {};
  const latestDrop = {};

  // Players whose add lands AFTER this week. An effective-tomorrow swap submitted on a week's final
  // day stamps add_date = the NEXT week's first day, and files the entry under the week it was
  // submitted in — so the date is out of range for latestAdd below while sitting in this week's
  // bucket, and the incoming player is already in this week's roster array. That date is positive
  // evidence he was not yet rostered here, so he must not reach the roster-array fallback and be
  // credited a week he never played.
  const joinedAfterWeek = new Set();

  const inPeriod = (date) => !periodStart || date >= periodStart;

  for (const players of Object.values(mgrDates || {})) {
    for (const [player, d] of Object.entries(players || {})) {
      if (!d) continue;
      if (d.add_date && inPeriod(d.add_date) && d.add_date > weekEnd) joinedAfterWeek.add(player);
      if (d.add_date && inPeriod(d.add_date) && d.add_date <= weekEnd) {
        if (!latestAdd[player] || d.add_date > latestAdd[player]) latestAdd[player] = d.add_date;
      }
      if (d.drop_date && inPeriod(d.drop_date) && d.drop_date <= weekEnd) {
        if (!latestDrop[player] || d.drop_date > latestDrop[player]) latestDrop[player] = d.drop_date;
      }
    }
  }

  const windows = {};
  for (const player of new Set([...Object.keys(latestAdd), ...Object.keys(latestDrop)])) {
    const add = latestAdd[player] || null;
    const drop = latestDrop[player] || null;
    const start = add && add > weekStart ? add : weekStart;
    if (add && (!drop || add > drop)) {
      windows[player] = { start, end: weekEnd }; // still rostered at the week's end
    } else if (drop && drop >= weekStart) {
      // drop_date is INCLUSIVE — the last day the player is rostered and still scores.
      windows[player] = { start, end: drop };
    }
    // dropped before this week began, and not re-added: not his at all this week
  }

  // The fallback, and the reason it is narrow. A player in the week's roster array with NO date
  // event anywhere is one the array is the only record of — an original-draft player, or a week
  // carried forward before dates were tracked. A player who has dates is governed by them, full
  // stop, or the array would quietly resurrect somebody the dates say was dropped.
  //
  // KNOWN ASYMMETRY, preserved deliberately: latestAdd/latestDrop are PERIOD-SCOPED, so a holdover
  // whose only date event is in a PRIOR period reads here as a player with no dates at all, and the
  // array puts him back. In practice the array should never carry him — auto-advance refuses to
  // cross a period boundary and rebuildRosterArraysFromDates re-derives from the dates — so this
  // firing means a data anomaly rather than a normal week. Narrowing it is a scoring change, and
  // this module was extracted to be byte-faithful to what the app already does; the shadow
  // comparison reports it as `prior_period_via_array` so the decision is made on real numbers.
  for (const player of [...(rosterArray.batters || []), ...(rosterArray.pitchers || [])]) {
    if (!windows[player] && !latestAdd[player] && !latestDrop[player] && !joinedAfterWeek.has(player)) {
      windows[player] = { start: weekStart, end: weekEnd };
    }
  }

  return windows;
}

// Is a window the whole week? A caller that scores by clipping daily rows can skip the clip — and,
// more importantly, the stored weekly_score is right as it stands, which is what the existing
// scoring path relies on.
export function isFullWeek(window, weekStart, weekEnd) {
  if (!window) return false;
  return (!window.start || window.start <= weekStart) && (!window.end || window.end >= weekEnd);
}

// Does this date fall inside the window? Both ends inclusive.
export function dateInWindow(window, date) {
  if (!window || !date) return false;
  return (!window.start || date >= window.start) && (!window.end || date <= window.end);
}

// The shape managerRowScoreForWeek already understands: an add/drop pair relative to the week,
// where a boundary that equals the week's own boundary is expressed as absent. Lets the windows
// derivation drive the EXISTING scorer rather than needing a second one written beside it.
export function windowAsDates(window, weekStart, weekEnd) {
  if (!window) return null;
  return {
    add_date: window.start && window.start > weekStart ? window.start : undefined,
    drop_date: window.end && window.end < weekEnd ? window.end : undefined,
  };
}

// What the two derivations disagree about for one manager-week.
//
// The burn-in tool. `windows` is this module's answer; `eligible` is the legacy union of five
// heuristics. `claimed_only_by_legacy` is the dangerous direction — a player the old path credits
// and the windows say was not his — and `claimed_only_by_windows` is the other, which is usually a
// player the array cache forgot.
export function diffEligibility(windows, eligible) {
  const w = new Set(Object.keys(windows || {}));
  const e = new Set(eligible || []);
  return {
    agree: [...w].filter((p) => e.has(p)).sort(),
    claimed_only_by_windows: [...w].filter((p) => !e.has(p)).sort(),
    claimed_only_by_legacy: [...e].filter((p) => !w.has(p)).sort(),
  };
}
