import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_FORMAT,
  BACKUP_KEEP_DAYS,
  IRREPLACEABLE_SEASON_KEYS,
  backupContentKey,
  backupManagers,
  backupsEqual,
  buildIrreplaceableBackup,
  describeBackup,
  diffBackups,
  expiredBackupDates,
} from '../js/backupSet.js';

const DB = {
  last_saved_at: '2026-09-02T12:00:00.000Z',
  active_season: '2026',
  banner_config: { image: 'x.png' },
  audit_log: [{ action: 'swap_approved' }],
  managers: [
    { name: 'Daniel Kortan', email: 'dk@example.com', password: 'hunter2', commissioner: true },
    { name: 'Joey Auclair', email: 'ja@example.com', password: 'swordfish' },
  ],
  seasons: {
    2026: {
      status: 'complete',
      schedule_dates: [{ round: 'PP1', week: 'Week 1', start: '2026-05-04', end: '2026-05-10' }],
      roster_dates: { 'Daniel Kortan': { 'PP1|Week 1': { 'Aaron Judge': { add_date: '2026-05-04' } } } },
      rosters: { 'Daniel Kortan': { 'PP1|Week 1': { batters: ['Aaron Judge'], pitchers: [] } } },
      swaps: [
        { manager: 'Daniel Kortan', player_out: 'A', player_in: 'B', status: 'approved', week_key: 'PP1|Week 2' },
      ],
      initial_submissions: { 'Daniel Kortan': { batters: ['Aaron Judge'], pitchers: [] } },
      roasts: { 'Joey Auclair': 'ouch' },
      season_closed: true,
      // Everything below is regenerable and must not survive into the payload.
      daily_batting: [{ batter: 'Aaron Judge' }],
      daily_pitching: [{ pitcher: 'Tarik Skubal' }],
      weekly_batting: [{ batter: 'Aaron Judge' }],
      weekly_pitching: [],
      batters_pool: ['Aaron Judge'],
      pitchers_pool: [],
      batters_team: { 'Aaron Judge': 'NYY' },
      playoff_odds: { day: '2026-08-01' },
      hot_takes: { day: '2026-08-01' },
      score_snapshots: [{ date: '2026-08-01' }],
      upload_log: [{ type: 'mlbapi_sync' }],
    },
  },
};

describe('buildIrreplaceableBackup', () => {
  const payload = buildIrreplaceableBackup(DB, {
    certifiedTotals: { 2026: { 'Daniel Kortan': { total: 1234.5 } } },
    createdAt: '2026-09-02T12:00:00.000Z',
  });

  it('stamps a format so a reader knows what they are holding', () => {
    assert.equal(payload.format, BACKUP_FORMAT);
    assert.equal(payload.created_at, '2026-09-02T12:00:00.000Z');
  });

  it('keeps every field that exists nowhere else', () => {
    const sd = payload.seasons['2026'];
    for (const key of ['roster_dates', 'rosters', 'swaps', 'initial_submissions', 'roasts', 'schedule_dates']) {
      assert.ok(sd[key] !== undefined, `${key} must survive the backup`);
    }
    assert.equal(payload.active_season, '2026');
    assert.deepEqual(payload.audit_log, [{ action: 'swap_approved' }]);
  });

  it('drops every field that can be regenerated', () => {
    const sd = payload.seasons['2026'];
    for (const key of [
      'daily_batting',
      'daily_pitching',
      'weekly_batting',
      'weekly_pitching',
      'batters_pool',
      'batters_team',
      'playoff_odds',
      'hot_takes',
      'score_snapshots',
      'upload_log',
    ]) {
      assert.equal(sd[key], undefined, `${key} is regenerable and must not be in the backup`);
    }
  });

  it('carries the certified totals, which are what make a restore checkable', () => {
    assert.deepEqual(payload.seasons['2026'].certified_totals, { 'Daniel Kortan': { total: 1234.5 } });
  });

  it('says what it left out and why', () => {
    assert.match(payload.omitted.daily_batting, /MLB Stats API/);
    assert.match(payload.omitted.passwords, /stripped on purpose/);
  });

  it('keeps identities and strips passwords', () => {
    assert.equal(payload.managers.length, 2);
    assert.equal(payload.managers[0].name, 'Daniel Kortan');
    assert.equal(payload.managers[0].commissioner, true);
    for (const m of payload.managers) assert.equal(m.password, undefined);
    // …and does not reach into the live object to do it.
    assert.equal(DB.managers[0].password, 'hunter2');
  });

  // The fixed `omitted` note is ~700 bytes, which swamps a 1 KB fixture, so this measures against a
  // database shaped like the real one: stat rows are the bulk of it, and they are what goes.
  it('is a fraction of the size of a database whose bulk is stat rows', () => {
    const fat = JSON.parse(JSON.stringify(DB));
    fat.seasons['2026'].daily_batting = Array.from({ length: 5000 }, (_, i) => ({
      date: '2026-05-05',
      round: 'PP1',
      week: 'Week 1',
      batter: `Player ${i}`,
      cumulative: { hr: 0, r: 1, rbi: 2 },
      delta: { hr: 0, r: 1, rbi: 2 },
    }));
    const full = JSON.stringify(fat).length;
    const slim = JSON.stringify(buildIrreplaceableBackup(fat)).length;
    assert.ok(slim < full / 10, `backup (${slim}) should be far smaller than the database (${full})`);
  });

  it('survives an empty or absent database', () => {
    assert.deepEqual(buildIrreplaceableBackup({}).seasons, {});
    assert.deepEqual(buildIrreplaceableBackup(null).seasons, {});
    assert.deepEqual(buildIrreplaceableBackup(null).managers, []);
  });

  it('skips a season entry that is not an object', () => {
    const payload2 = buildIrreplaceableBackup({ seasons: { 2026: null, 2027: 'nope' } });
    assert.deepEqual(payload2.seasons, {});
  });
});

describe('backupManagers', () => {
  it('answers for nothing', () => {
    assert.deepEqual(backupManagers(null), []);
    assert.deepEqual(backupManagers([null]), [{}]);
  });
});

describe('describeBackup', () => {
  it('counts what a human would ask about', () => {
    const d = describeBackup(
      buildIrreplaceableBackup(DB, { certifiedTotals: { 2026: { 'Daniel Kortan': { total: 1 } } } })
    );
    assert.equal(d.managers, 2);
    assert.deepEqual(d.seasons['2026'], {
      status: 'complete',
      schedule_dates: 1,
      managers_with_dates: 1,
      roster_events: 1,
      swaps: 1,
      roasts: 1,
      season_closed: true,
      certified_managers: 1,
    });
  });

  it('answers for an empty payload', () => {
    assert.deepEqual(describeBackup(null), { format: null, created_at: null, managers: 0, seasons: {} });
  });
});

describe('diffBackups', () => {
  const base = buildIrreplaceableBackup(DB, { certifiedTotals: { 2026: { 'Daniel Kortan': { total: 1000 } } } });

  it('reports nothing when nothing moved', () => {
    assert.deepEqual(diffBackups(base, base), { changed: false, seasons: {} });
  });

  it('catches a swap that appeared', () => {
    const next = JSON.parse(JSON.stringify(base));
    next.seasons['2026'].swaps.push({
      manager: 'Joey Auclair',
      player_out: 'C',
      player_in: 'D',
      status: 'pending',
      week_key: 'PP2|Week 1',
    });
    const d = diffBackups(base, next);
    assert.equal(d.changed, true);
    assert.equal(d.seasons['2026'].swaps_added.length, 1);
    assert.equal(d.seasons['2026'].swaps_added[0].player_in, 'D');
  });

  it('catches a swap whose status changed, without calling it added or removed', () => {
    const next = JSON.parse(JSON.stringify(base));
    next.seasons['2026'].swaps[0].status = 'rejected';
    const d = diffBackups(base, next);
    assert.deepEqual(d.seasons['2026'].swaps_added, []);
    assert.deepEqual(d.seasons['2026'].swaps_removed, []);
    assert.equal(d.seasons['2026'].swaps_changed[0].from, 'approved');
    assert.equal(d.seasons['2026'].swaps_changed[0].to, 'rejected');
  });

  it('catches a roster window that moved — the twelve-day question', () => {
    const next = JSON.parse(JSON.stringify(base));
    next.seasons['2026'].roster_dates['Daniel Kortan']['PP1|Week 1']['Aaron Judge'].drop_date = '2026-05-08';
    const d = diffBackups(base, next);
    assert.deepEqual(d.seasons['2026'].roster_events_moved, [
      { key: 'Daniel Kortan|PP1|Week 1|Aaron Judge', from: '2026-05-04→', to: '2026-05-04→2026-05-08' },
    ]);
  });

  it('catches a roster event that vanished', () => {
    const next = JSON.parse(JSON.stringify(base));
    delete next.seasons['2026'].roster_dates['Daniel Kortan']['PP1|Week 1']['Aaron Judge'];
    const d = diffBackups(base, next);
    assert.deepEqual(d.seasons['2026'].roster_events_removed, ['Daniel Kortan|PP1|Week 1|Aaron Judge']);
  });

  it('catches a certified total that moved, and ignores a rounding wobble', () => {
    const moved = JSON.parse(JSON.stringify(base));
    moved.seasons['2026'].certified_totals['Daniel Kortan'].total = 1031.1;
    assert.deepEqual(diffBackups(base, moved).seasons['2026'].certified_totals_moved, { 'Daniel Kortan': 31.1 });

    const wobble = JSON.parse(JSON.stringify(base));
    wobble.seasons['2026'].certified_totals['Daniel Kortan'].total = 1000.005;
    assert.equal(diffBackups(base, wobble).changed, false);
  });

  it('handles a season present on one side only', () => {
    const next = JSON.parse(JSON.stringify(base));
    next.seasons['2027'] = { swaps: [{ manager: 'M', player_out: 'X', player_in: 'Y', status: 'approved' }] };
    const d = diffBackups(base, next);
    assert.equal(d.seasons['2027'].swaps_added.length, 1);
  });
});

describe('backupsEqual', () => {
  it('ignores created_at, which changes on every run by construction', () => {
    const a = buildIrreplaceableBackup(DB, { createdAt: '2026-09-02T23:00:00.000Z' });
    const b = buildIrreplaceableBackup(DB, { createdAt: '2026-09-03T23:00:00.000Z' });
    assert.equal(backupsEqual(a, b), true, 'two runs over the same data are the same backup');
    assert.notEqual(a.created_at, b.created_at);
  });

  it('ignores last_saved_at, which any unrelated write bumps', () => {
    const a = buildIrreplaceableBackup({ ...DB, last_saved_at: '2026-09-02T12:00:00.000Z' });
    const b = buildIrreplaceableBackup({ ...DB, last_saved_at: '2026-09-03T04:00:00.000Z' });
    assert.equal(backupsEqual(a, b), true, 'a write that changed nothing is not a change');
  });

  it('sees a swap that appeared', () => {
    const a = buildIrreplaceableBackup(DB);
    const moved = JSON.parse(JSON.stringify(DB));
    moved.seasons['2026'].swaps.push({ manager: 'M', player_out: 'X', player_in: 'Y', status: 'pending' });
    assert.equal(backupsEqual(a, buildIrreplaceableBackup(moved)), false);
  });

  it('sees a roster window that moved', () => {
    const a = buildIrreplaceableBackup(DB);
    const moved = JSON.parse(JSON.stringify(DB));
    moved.seasons['2026'].roster_dates['Daniel Kortan']['PP1|Week 1']['Aaron Judge'].drop_date = '2026-05-08';
    assert.equal(backupsEqual(a, buildIrreplaceableBackup(moved)), false);
  });

  it('sees a certified total that moved', () => {
    const a = buildIrreplaceableBackup(DB, { certifiedTotals: { 2026: { M: { total: 1 } } } });
    const b = buildIrreplaceableBackup(DB, { certifiedTotals: { 2026: { M: { total: 2 } } } });
    assert.equal(backupsEqual(a, b), false);
  });

  it('is false when either side is missing — never skip a write on nothing', () => {
    const a = buildIrreplaceableBackup(DB);
    assert.equal(backupsEqual(a, null), false);
    assert.equal(backupsEqual(null, a), false);
    assert.equal(backupsEqual(null, null), false);
  });

  it('backupContentKey answers empty for a non-object', () => {
    assert.equal(backupContentKey(null), '');
    assert.equal(backupContentKey('nope'), '');
  });
});

describe('expiredBackupDates', () => {
  it('keeps everything inside the window', () => {
    assert.deepEqual(expiredBackupDates(['2026-09-01', '2026-09-02'], '2026-09-02', 365), []);
  });

  it('drops what has aged out', () => {
    assert.deepEqual(expiredBackupDates(['2025-01-01', '2026-08-30', '2026-09-02'], '2026-09-02', 365), ['2025-01-01']);
  });

  it('never deletes the newest copy, however old it is', () => {
    assert.deepEqual(expiredBackupDates(['2020-01-01'], '2026-09-02', 365), []);
    assert.deepEqual(expiredBackupDates(['2020-01-01', '2020-01-02'], '2026-09-02', 365), ['2020-01-01']);
  });

  it('de-duplicates and ignores blanks', () => {
    assert.deepEqual(expiredBackupDates(['2020-01-01', '2020-01-01', '', null, '2026-09-02'], '2026-09-02'), [
      '2020-01-01',
    ]);
  });

  it('defaults to a year', () => {
    assert.equal(BACKUP_KEEP_DAYS, 365);
  });
});

describe('the key lists themselves', () => {
  it('never lists a field twice', () => {
    assert.equal(new Set(IRREPLACEABLE_SEASON_KEYS).size, IRREPLACEABLE_SEASON_KEYS.length);
  });

  it('does not carry a stat array by accident', () => {
    for (const k of IRREPLACEABLE_SEASON_KEYS) assert.ok(!/^(daily|weekly)_/.test(k), `${k} is regenerable`);
  });
});
