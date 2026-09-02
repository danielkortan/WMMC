// ============================================================
// WMMC — Backing up by replaceability
// ============================================================
// Render takes a disk snapshot every 24 hours and keeps seven days, so catastrophic loss is
// covered. What that leaves is narrower, and is exactly this app's shape:
//
//   * SEVEN DAYS OF MEMORY. The 8/31 misattribution went unnoticed for twelve. A defect that takes
//     longer than a week to spot is outside the window entirely.
//   * ALL-OR-NOTHING, WHOLE-DISK. Render's own warning: "All changes to your disk that occurred
//     after the selected snapshot will be lost." Rolling back to recover one manager's swap log
//     throws away every stat sync and every other manager's swaps since. In-season you would never
//     actually press it, so it covers total corruption and not the surgical case this app produces.
//   * OPAQUE. You cannot see what a snapshot holds without restoring it.
//
// The fix is not more backup, it is a smaller and better-chosen one. slimForBackup (server.js)
// strips by SIZE. The right criterion is REPLACEABILITY:
//
//   The stat rows — 15.3 MB of a 17.3 MB file — re-fetch from the MLB Stats API. The pools
//   re-bootstrap from MLB's catalog. The team maps, the odds, the hot takes and the weekly rollups
//   are all derived. But roster_dates, the swaps, the submissions, the roster arrays, the roasts
//   and the hand-set schedule exist NOWHERE ELSE. On production that is 0.25 MB.
//
// At that size the retention argument inverts. A year of DAILY copies of the league's irreplaceable
// history is about 90 MB — five current db.json files — and because they are dated and diffable,
// the twelve-day question ("when did this week's attribution change?") becomes answerable, which no
// whole-disk snapshot can do at any retention. Losing every stat row costs a re-sync. Losing the
// swap log costs the season.
//
// PASSWORDS ARE STRIPPED, following managers_seed.json's rule: a dated trail of copies multiplies
// the exposure of a plaintext credential, and a commissioner can re-issue a password in a minute.
// Identities, emails and the commissioner flag are kept, so a restore knows who the league is.
//
// Canonical copy. Mirrored verbatim in server.js and guarded by tests/serverMirrors.test.js.

export const BACKUP_FORMAT = 'wmmc-irreplaceable-v1';

// Default retention for the dated local copies. A year of them is ~90 MB against a 1 GB disk.
export const BACKUP_KEEP_DAYS = 365;

// Season fields that exist nowhere but this database.
//
// schedule_dates is on this list for a reason that is not size: its silent wipe is the incident
// that motivated the boot-time integrity audit in the first place, and it is hand-set, so nothing
// regenerates it.
export const IRREPLACEABLE_SEASON_KEYS = [
  'status',
  'schedule_dates',
  'roster_dates',
  'rosters',
  'swaps',
  'initial_submissions',
  'period_submissions',
  'submission_windows',
  'eliminated',
  'roasts',
  'season_closed',
  'mlb_ids',
  'held_players',
  'stat_retention',
  'correction_flags',
  'rollup_drift',
];

// Top-level fields likewise. audit_log is here because it is the only record of who did what —
// a stat row can be re-fetched, a decision cannot.
export const IRREPLACEABLE_ROOT_KEYS = ['active_season', 'banner_config', 'audit_log', 'last_saved_at'];

// Everything deliberately left out, with the reason. Carried in the payload so a person reading a
// restored file three months from now does not have to guess whether something went missing.
export const REPLACEABLE_NOTE = {
  daily_batting: 're-fetch from the MLB Stats API',
  daily_pitching: 're-fetch from the MLB Stats API',
  weekly_batting: 'rebuilt from the daily rows',
  weekly_pitching: 'rebuilt from the daily rows',
  batters_pool: 're-bootstraps from the MLB catalog',
  pitchers_pool: 're-bootstraps from the MLB catalog',
  batters_team: 'rewritten by the next sync',
  pitchers_team: 'rewritten by the next sync',
  playoff_odds: 'recomputed nightly',
  bracket_odds: 'recomputed nightly',
  hot_takes: 'regenerated daily',
  score_snapshots: 'the guard trail — the certified totals below are the part worth keeping',
  upload_log: 'a log of syncs that can be run again',
  passwords: 'stripped on purpose — a commissioner re-issues one',
};

// Manager identities without credentials.
export function backupManagers(managers) {
  return (managers || []).map((m) => {
    const { password: _password, ...rest } = m || {};
    return rest;
  });
}

function pick(source, keys) {
  const out = {};
  for (const k of keys) if (source && source[k] !== undefined) out[k] = source[k];
  return out;
}

// The payload. `certifiedTotals` maps a year to that season's per-manager totals — the caller
// computes them (captureScoreSnapshot is server-only glue), and they are what makes this backup
// SELF-VERIFYING: a restore can be checked against what the season actually was, rather than
// against a hope. Without them a restored file is a set of roster dates nobody can confirm.
export function buildIrreplaceableBackup(db, { certifiedTotals = {}, createdAt = null } = {}) {
  const seasons = {};
  for (const [year, sd] of Object.entries((db && db.seasons) || {})) {
    if (!sd || typeof sd !== 'object') continue;
    seasons[year] = pick(sd, IRREPLACEABLE_SEASON_KEYS);
    if (certifiedTotals[year]) seasons[year].certified_totals = certifiedTotals[year];
  }
  return {
    format: BACKUP_FORMAT,
    created_at: createdAt || new Date().toISOString(),
    omitted: REPLACEABLE_NOTE,
    ...pick(db || {}, IRREPLACEABLE_ROOT_KEYS),
    managers: backupManagers((db || {}).managers),
    seasons,
  };
}

// One-glance contents, for the restore-point picker and for the list endpoint. Deliberately counts
// the things a human would ask about — how many swaps, how many roster events — rather than bytes.
export function describeBackup(payload) {
  const seasons = {};
  for (const [year, sd] of Object.entries((payload && payload.seasons) || {})) {
    let rosterEvents = 0;
    for (const weeks of Object.values((sd || {}).roster_dates || {})) {
      for (const players of Object.values(weeks || {})) rosterEvents += Object.keys(players || {}).length;
    }
    seasons[year] = {
      status: (sd || {}).status || null,
      schedule_dates: Array.isArray((sd || {}).schedule_dates) ? sd.schedule_dates.length : 0,
      managers_with_dates: Object.keys((sd || {}).roster_dates || {}).length,
      roster_events: rosterEvents,
      swaps: Array.isArray((sd || {}).swaps) ? sd.swaps.length : 0,
      roasts: Object.keys((sd || {}).roasts || {}).length,
      season_closed: !!(sd || {}).season_closed,
      certified_managers: Object.keys((sd || {}).certified_totals || {}).length,
    };
  }
  return {
    format: (payload && payload.format) || null,
    created_at: (payload && payload.created_at) || null,
    managers: ((payload && payload.managers) || []).length,
    seasons,
  };
}

// A stable identity for one swap, so two backups can be compared without depending on array order.
function swapId(s, i) {
  if (!s || typeof s !== 'object') return `#${i}`;
  return [s.manager || '', s.player_out || '', s.player_in || '', s.week_key || '', s.submitted_at || ''].join('|');
}

// What changed between two dated backups.
//
// This is the whole argument for keeping them. A whole-disk snapshot can restore last Tuesday; it
// cannot tell you that this week's attribution changed on Tuesday, which is the question twelve days
// of silence actually raised. Reports per season: swaps added, removed or changed status; roster
// events added or removed; and every manager whose certified total moved.
export function diffBackups(before, after) {
  const years = new Set([
    ...Object.keys((before && before.seasons) || {}),
    ...Object.keys((after && after.seasons) || {}),
  ]);
  const seasons = {};
  let changed = false;

  for (const year of [...years].sort()) {
    const a = ((before && before.seasons) || {})[year] || {};
    const b = ((after && after.seasons) || {})[year] || {};

    const aSwaps = new Map((a.swaps || []).map((s, i) => [swapId(s, i), s]));
    const bSwaps = new Map((b.swaps || []).map((s, i) => [swapId(s, i), s]));
    const swapsAdded = [...bSwaps.keys()].filter((k) => !aSwaps.has(k)).map((k) => bSwaps.get(k));
    const swapsRemoved = [...aSwaps.keys()].filter((k) => !bSwaps.has(k)).map((k) => aSwaps.get(k));
    const swapsChanged = [];
    for (const [k, swap] of bSwaps) {
      const prior = aSwaps.get(k);
      if (prior && prior.status !== swap.status) {
        swapsChanged.push({ swap, from: prior.status || null, to: swap.status || null });
      }
    }

    const flatten = (sd) => {
      const out = new Map();
      for (const [mgr, weeks] of Object.entries((sd || {}).roster_dates || {})) {
        for (const [wk, players] of Object.entries(weeks || {})) {
          for (const [player, d] of Object.entries(players || {})) {
            out.set(`${mgr}|${wk}|${player}`, `${(d || {}).add_date || ''}→${(d || {}).drop_date || ''}`);
          }
        }
      }
      return out;
    };
    const aEvents = flatten(a);
    const bEvents = flatten(b);
    const rosterAdded = [...bEvents.keys()].filter((k) => !aEvents.has(k));
    const rosterRemoved = [...aEvents.keys()].filter((k) => !bEvents.has(k));
    const rosterMoved = [...bEvents.keys()]
      .filter((k) => aEvents.has(k) && aEvents.get(k) !== bEvents.get(k))
      .map((k) => ({ key: k, from: aEvents.get(k), to: bEvents.get(k) }));

    const totalsMoved = {};
    const aT = a.certified_totals || {};
    const bT = b.certified_totals || {};
    for (const mgr of new Set([...Object.keys(aT), ...Object.keys(bT)])) {
      const d = ((bT[mgr] || {}).total || 0) - ((aT[mgr] || {}).total || 0);
      if (Math.abs(d) > 0.01) totalsMoved[mgr] = Math.round(d * 10) / 10;
    }

    const any =
      swapsAdded.length ||
      swapsRemoved.length ||
      swapsChanged.length ||
      rosterAdded.length ||
      rosterRemoved.length ||
      rosterMoved.length ||
      Object.keys(totalsMoved).length;
    if (!any) continue;
    changed = true;
    seasons[year] = {
      swaps_added: swapsAdded,
      swaps_removed: swapsRemoved,
      swaps_changed: swapsChanged,
      roster_events_added: rosterAdded,
      roster_events_removed: rosterRemoved,
      roster_events_moved: rosterMoved,
      certified_totals_moved: totalsMoved,
    };
  }

  return { changed, seasons };
}

// Which dated files to delete. Keeps everything within `keepDays` of today, and — because a file
// this small is not worth a cliff — never deletes the newest one even if it has aged out.
export function expiredBackupDates(dates, todayISO, keepDays = BACKUP_KEEP_DAYS) {
  const sorted = [...new Set(dates || [])].filter(Boolean).sort();
  if (sorted.length <= 1) return [];
  const cutoff = new Date(`${todayISO}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const newest = sorted[sorted.length - 1];
  return sorted.filter((d) => d < cutoffISO && d !== newest);
}
