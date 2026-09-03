// ============================================================
// WMMC — Freezing a finished season
// ============================================================
// 85.5% of a season's stat rows, and 83.2% of its bytes, belong to players nobody in this league
// ever rostered. js/statRetention.js stops that being written from 2027 onward; this is the other
// half — the one-time compaction of a season already written.
//
// The whole design rests on one claim, and the endpoint that calls this PROVES the claim rather
// than asserting it: every row the scoreboard can reach belongs to a rostered player on a rostered
// day, so removing the rest cannot move a single point. The caller captures per-manager totals
// before and after and refuses to write on any difference at all. Compaction is correct exactly
// when it is invisible.
//
// PURE — it is handed the keep-sets and returns a new season object, mutating nothing. Deriving the
// keep-sets is the server's job (weekRosterWindows over every manager × every week), which is the
// same derivation the scoreboard scores from.
//
// Canonical copy. Mirrored verbatim in server.js and guarded by tests/serverMirrors.test.js.

// The tiers are CUMULATIVE: tier 3 does everything tiers 1 and 2 do. Measured against production
// 2026 (15.59 MB as the API exposes it):
//
//   1  dailies filtered to rostered player-days      5.21 MB   −10.38
//   2  + weeklies filtered to rostered players       2.83 MB    −2.38
//   3  + drop derived caches, shrink pools and maps  2.74 MB    −0.09
//   4  + trim the duplicated cumulative and zeros    1.82 MB    −0.92
//
// Tier 3 is nearly worthless and tier 4 saves ten times as much, which is the opposite of how they
// were first ordered. If only two steps are taken, take 1 and 4.
export const ARCHIVE_TIERS = [1, 2, 3, 4];
export const DEFAULT_ARCHIVE_TIER = 4;

// How many of each rolling trail to keep. The last score snapshot is the certified-totals record —
// dropping it would leave a frozen season with no way to check itself.
export const ARCHIVE_KEEP_SNAPSHOTS = 1;
export const ARCHIVE_KEEP_UPLOADS = 5;

// Stat keys safe to drop when zero, because every reader in the app already writes `d[k] || 0`.
// An ALLOWLIST rather than "any zero-valued key", so no structural field can ever be trimmed away
// by a stat row that happens to carry a zero.
export const TRIMMABLE_STAT_KEYS = new Set([
  '1b',
  '2b',
  '3b',
  'hr',
  'r',
  'rbi',
  'sb',
  'bb',
  'abs',
  'so',
  'lob',
  'w',
  'qs',
  'cg',
  'cgso',
  'nh',
  'ip',
  'h',
  'er',
  'k',
  'sv',
  'hld',
  'l',
]);

export function dayKey(player, date) {
  return `${player}|${date}`;
}

// Tier 1. A daily row survives when somebody held that player ON that date.
export function compactDailyRows(rows, playerKey, keptDays) {
  return (rows || []).filter((r) => keptDays.has(dayKey(r[playerKey], r.date)));
}

// Tier 2. A weekly row survives when somebody held that player at some point in the season. The
// looser test is deliberate: a weekly row is one per player per week and cheap, and the frozen
// Season Stats views read them for players a manager held in ANY week.
export function compactWeeklyRows(rows, playerKey, keptPlayers) {
  return (rows || []).filter((r) => keptPlayers.has(r[playerKey]));
}

// Tier 3. Restrict a name-keyed map (batters_team, pitchers_team, mlb_ids) to the kept names.
export function restrictMap(map, keptPlayers) {
  const out = {};
  for (const [name, value] of Object.entries(map || {})) if (keptPlayers.has(name)) out[name] = value;
  return out;
}

// Tier 4. Two pure duplications, worth 32% and 44% of a row respectively.
//
// `cumulative` is byte-identical to `delta` on every per-game row the MLB sync writes — it sets
// `cumulative: gameStats, delta: gameStats` — and every reader already does `r.delta || r.cumulative`.
// It is dropped ONLY when the two are actually equal, so a gsheets-era row (where cumulative is a
// running week-to-date total and genuinely differs) keeps both.
export function trimStatRow(row) {
  const out = { ...row };
  const trimObj = (o) => {
    const t = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v === 0 && TRIMMABLE_STAT_KEYS.has(k.toLowerCase())) continue;
      t[k] = v;
    }
    return t;
  };
  if (out.delta && out.cumulative && JSON.stringify(out.delta) === JSON.stringify(out.cumulative)) {
    delete out.cumulative;
  }
  if (out.delta) out.delta = trimObj(out.delta);
  if (out.cumulative) out.cumulative = trimObj(out.cumulative);
  for (const [k, v] of Object.entries(out)) {
    if (v === 0 && TRIMMABLE_STAT_KEYS.has(k.toLowerCase())) delete out[k];
  }
  return out;
}

// The whole operation. Returns a NEW season object; `sd` is untouched, so a dry run and an apply
// run exactly the same code and the caller decides whether to keep the result.
export function compactSeason(sd, { tier = DEFAULT_ARCHIVE_TIER, keptDays, keptPlayers } = {}) {
  const out = { ...sd };
  const days = keptDays || new Set();
  const players = keptPlayers || new Set();

  if (tier >= 1) {
    out.daily_batting = compactDailyRows(sd.daily_batting, 'batter', days);
    out.daily_pitching = compactDailyRows(sd.daily_pitching, 'pitcher', days);
  }
  if (tier >= 2) {
    out.weekly_batting = compactWeeklyRows(sd.weekly_batting, 'batter', players);
    out.weekly_pitching = compactWeeklyRows(sd.weekly_pitching, 'pitcher', players);
  }
  if (tier >= 3) {
    // The swing guard's rolling trail is meaningless once nothing can change — but the LAST entry
    // is the certified-totals record, and a frozen season with no way to check itself is worse
    // than a slightly larger one.
    if (Array.isArray(sd.score_snapshots)) out.score_snapshots = sd.score_snapshots.slice(-ARCHIVE_KEEP_SNAPSHOTS);
    if (Array.isArray(sd.upload_log)) out.upload_log = sd.upload_log.slice(-ARCHIVE_KEEP_UPLOADS);
    delete out.playoff_odds;
    delete out.bracket_odds;
    delete out.hot_takes;
    // The pools are the whole MLB active catalog, carried only for the live swap form's
    // autocomplete. A frozen season has no swap form.
    const sorted = [...players].sort();
    out.batters_pool = sorted.filter((p) => (sd.batters_pool || []).includes(p));
    out.pitchers_pool = sorted.filter((p) => (sd.pitchers_pool || []).includes(p));
    out.batters_team = restrictMap(sd.batters_team, players);
    out.pitchers_team = restrictMap(sd.pitchers_team, players);
    if (sd.mlb_ids) out.mlb_ids = restrictMap(sd.mlb_ids, players);
  }
  if (tier >= 4) {
    out.daily_batting = (out.daily_batting || []).map(trimStatRow);
    out.daily_pitching = (out.daily_pitching || []).map(trimStatRow);
    out.weekly_batting = (out.weekly_batting || []).map(trimStatRow);
    out.weekly_pitching = (out.weekly_pitching || []).map(trimStatRow);
  }
  return out;
}

// What the compaction did, in the terms a person would ask about.
export function archiveSummary(before, after) {
  const count = (sd, k) => (Array.isArray(sd[k]) ? sd[k].length : 0);
  const bytes = (v) => (v === undefined ? 0 : JSON.stringify(v).length);
  const arrays = ['daily_batting', 'daily_pitching', 'weekly_batting', 'weekly_pitching'];
  const rows = {};
  for (const k of arrays) rows[k] = { before: count(before, k), after: count(after, k) };
  const b = bytes(before);
  const a = bytes(after);
  return {
    rows,
    rows_before: arrays.reduce((n, k) => n + rows[k].before, 0),
    rows_after: arrays.reduce((n, k) => n + rows[k].after, 0),
    bytes_before: b,
    bytes_after: a,
    mb_before: Math.round((b / 1048576) * 100) / 100,
    mb_after: Math.round((a / 1048576) * 100) / 100,
    reduction: b ? `${Math.round((1 - a / b) * 1000) / 10}%` : '0%',
  };
}
