// ============================================================
// WMMC — Which players' stat rows are worth storing
// ============================================================
// 85.5% of the rows in db.json — and 83.2% of its bytes — belong to players nobody in this league
// ever rostered. The sync writes a per-game row for every player who appeared in every game it
// fetches, so a full MLB season lands in the database whether or not a single manager ever held any
// of them. On production that is 15.3 MB of the 17.3 MB file, and the cost is not the disk (a
// gigabyte, about a quarter a month) — it is that readDB() parses the whole file on every request,
// twice on an authenticated one, against a 400 MB heap on a 512 MB instance.
//
// This module answers the write-side question: is this player one somebody in this league cares
// about? It is deliberately PERMISSIVE. Under-keeping loses points and over-keeping costs bytes,
// and those are not the same kind of mistake, so every source of "somebody meant to have this
// player" is unioned in — including swaps and submissions that are still PENDING, because a swap
// approved on Thursday can be stamped with a Tuesday add_date, and Tuesday's rows have to already
// exist for that to score.
//
// It is also OPT-IN PER SEASON (`sd.stat_retention`, default 'all'). 2026 is closed and its rows
// are already written; this is for 2027 onward, so that the offseason archive is a tidy-up rather
// than a rescue.
//
// The one hazard it cannot close by itself: a player NOBODY had — not rostered, not submitted, not
// in any swap — who is given a back-dated add by a commissioner. His rows for those days were never
// written. The repair is the one that already exists for a stale week, `POST /api/mlb/sync` for that
// round and week, which re-fetches from the MLB Stats API and now keeps him because the keep-set has
// changed. That is why this is a filter over regenerable data and not a delete.
//
// Canonical copy. Mirrored verbatim in server.js and guarded by tests/serverMirrors.test.js.

export const STAT_RETENTION_MODES = ['all', 'rostered'];

// What a season does when the mode has never been set. 'all' is today's behaviour to the byte, so
// adding this module changes nothing until a commissioner turns it on for a season.
export const DEFAULT_STAT_RETENTION = 'all';

// A season whose keep-set is smaller than this is almost certainly half-loaded rather than
// genuinely tiny — a fresh season before the draft, a partial restore — and filtering against it
// would silently throw away a week of real stats. performMLBSync falls back to 'all' below it.
export const RETENTION_MIN_KEEP = 40;

export function statRetentionMode(sd) {
  const mode = sd && sd.stat_retention;
  return STAT_RETENTION_MODES.includes(mode) ? mode : DEFAULT_STAT_RETENTION;
}

// Match key for a player name. Looser than the row and roster names themselves on purpose: an
// accent, a suffix or a stray period must never be the reason a rostered player's stats are
// dropped. (js/utils.js normalizeName is the same idea; this module stays self-contained so its
// server mirror can be a verbatim copy.)
export function retentionKey(name) {
  return String(name == null ? '' : name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every player any manager has held, asked for, or been offered this season.
//
// Five sources, unioned, and each one is here because it can be the ONLY record of a player at some
// point in his life on this league:
//
//   rosters          — the per-week arrays. A derived cache, but additive, so it never forgets.
//   roster_dates     — the authority for who was rostered when. The one that must never be missed.
//   swaps            — BOTH sides, and pending as well as approved. The player coming in has no
//                      roster entry until approval, and approval can back-date him.
//   submissions      — initial and per-period, including a roster still awaiting approval.
//   held_players     — an explicit escape hatch (see retainPlayers below) for anything the four
//                      derivations cannot see.
//
// Returns a Set of retentionKey()s.
export function seasonRetentionNames(sd) {
  const names = new Set();
  const add = (n) => {
    const key = retentionKey(n);
    if (key) names.add(key);
  };

  for (const weekRosters of Object.values((sd && sd.rosters) || {})) {
    for (const roster of Object.values(weekRosters || {})) {
      ((roster || {}).batters || []).forEach(add);
      ((roster || {}).pitchers || []).forEach(add);
    }
  }

  for (const weeks of Object.values((sd && sd.roster_dates) || {})) {
    for (const players of Object.values(weeks || {})) {
      Object.keys(players || {}).forEach(add);
    }
  }

  for (const swap of (sd && sd.swaps) || []) {
    add((swap || {}).player_in);
    add((swap || {}).player_out);
  }

  const fromSubmission = (s) => {
    ((s || {}).batters || []).forEach(add);
    ((s || {}).pitchers || []).forEach(add);
  };
  for (const s of Object.values((sd && sd.initial_submissions) || {})) fromSubmission(s);
  for (const period of Object.values((sd && sd.period_submissions) || {})) {
    for (const s of Object.values(period || {})) fromSubmission(s);
  }

  ((sd && sd.held_players) || []).forEach(add);

  return names;
}

// The decision object the sync paths carry for one run. Built once per sync rather than per row,
// because seasonRetentionNames walks the whole season.
//
// `active` is the only field a caller needs to branch on: it is false whenever the mode is 'all',
// and false when the keep-set is too small to trust, so a caller that forgets the mode check still
// writes everything rather than nothing.
export function buildRetentionFilter(sd) {
  const mode = statRetentionMode(sd);
  if (mode !== 'rostered') return { mode, active: false, names: null, size: 0, reason: 'mode is all' };
  const names = seasonRetentionNames(sd);
  if (names.size < RETENTION_MIN_KEEP) {
    return {
      mode,
      active: false,
      names,
      size: names.size,
      reason: `keep-set is ${names.size} players, below the ${RETENTION_MIN_KEEP} floor — storing everything`,
    };
  }
  return { mode, active: true, names, size: names.size, reason: null };
}

// Does a row for this player get written? An inactive filter keeps everything, which is what makes
// this safe to call unconditionally at every write site.
export function retainsPlayer(filter, name) {
  if (!filter || !filter.active || !filter.names) return true;
  return filter.names.has(retentionKey(name));
}

// The escape hatch. Names added here survive every filter for the rest of the season, whatever
// happens to the rosters — for the case where a player must be tracked before anyone can roster him
// (a commissioner watching a call-up) or where a derivation has been found wanting after the fact.
export function retainPlayers(sd, names) {
  if (!sd) return [];
  const existing = new Set((sd.held_players || []).map(retentionKey));
  const added = [];
  for (const n of names || []) {
    const key = retentionKey(n);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    added.push(String(n));
  }
  if (added.length) sd.held_players = [...(sd.held_players || []), ...added];
  return added;
}

// How much a run actually skipped, for the sync's response and its log line. Reported rather than
// silent: a retention filter that has quietly stopped keeping anyone would otherwise look exactly
// like a quiet day in the majors.
export function retentionSummary(filter, counts) {
  const c = counts || {};
  return {
    mode: (filter && filter.mode) || DEFAULT_STAT_RETENTION,
    active: !!(filter && filter.active),
    keep_set: (filter && filter.size) || 0,
    reason: (filter && filter.reason) || null,
    skipped_batting: c.batting || 0,
    skipped_pitching: c.pitching || 0,
  };
}
