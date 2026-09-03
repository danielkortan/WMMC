import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_KEEP_SNAPSHOTS,
  ARCHIVE_KEEP_UPLOADS,
  archiveSummary,
  compactDailyRows,
  compactSeason,
  compactWeeklyRows,
  dayKey,
  restrictMap,
  trimStatRow,
} from '../js/seasonArchive.js';

const season = () => ({
  status: 'complete',
  season_closed: true,
  schedule_dates: [{ round: 'PP1', week: 'Week 1', start: '2026-05-04', end: '2026-05-10' }],
  roster_dates: { M: { 'PP1|Week 1': { Kept: { add_date: '2026-05-04' } } } },
  rosters: { M: { 'PP1|Week 1': { batters: ['Kept'], pitchers: [] } } },
  swaps: [{ manager: 'M', player_in: 'Kept', status: 'approved' }],
  daily_batting: [
    {
      date: '2026-05-05',
      round: 'PP1',
      week: 'Week 1',
      batter: 'Kept',
      delta: { hr: 1, r: 0 },
      cumulative: { hr: 1, r: 0 },
    },
    {
      date: '2026-05-06',
      round: 'PP1',
      week: 'Week 1',
      batter: 'Kept',
      delta: { hr: 0, r: 2 },
      cumulative: { hr: 0, r: 2 },
    },
    { date: '2026-05-05', round: 'PP1', week: 'Week 1', batter: 'Nobody', delta: { hr: 3 }, cumulative: { hr: 3 } },
  ],
  daily_pitching: [
    { date: '2026-05-05', round: 'PP1', week: 'Week 1', pitcher: 'Arm', delta: { k: 8 }, cumulative: { k: 8 } },
    { date: '2026-05-05', round: 'PP1', week: 'Week 1', pitcher: 'Nobody Arm', delta: { k: 1 }, cumulative: { k: 1 } },
  ],
  weekly_batting: [
    { round: 'PP1', week: 'Week 1', batter: 'Kept', manager: 'M', hr: 1, r: 2, sb: 0, weekly_score: 14 },
    { round: 'PP1', week: 'Week 1', batter: 'Nobody', hr: 3, weekly_score: 30 },
  ],
  weekly_pitching: [{ round: 'PP1', week: 'Week 1', pitcher: 'Arm', manager: 'M', k: 8, weekly_score: 16 }],
  score_snapshots: [{ date: 'a' }, { date: 'b' }, { date: 'c' }],
  upload_log: Array.from({ length: 9 }, (_, i) => ({ n: i })),
  playoff_odds: { day: 'x' },
  bracket_odds: { day: 'x' },
  hot_takes: { day: 'x' },
  batters_pool: ['Kept', 'Nobody', 'Third Party'],
  pitchers_pool: ['Arm', 'Nobody Arm'],
  batters_team: { Kept: 'NYY', Nobody: 'BOS' },
  pitchers_team: { Arm: 'DET', 'Nobody Arm': 'SEA' },
  mlb_ids: { Kept: 1, Nobody: 2, Arm: 3 },
});

const keptDays = new Set([dayKey('Kept', '2026-05-05'), dayKey('Kept', '2026-05-06'), dayKey('Arm', '2026-05-05')]);
const keptPlayers = new Set(['Kept', 'Arm']);

describe('compactDailyRows', () => {
  it('keeps a rostered player on a rostered day and drops everyone else', () => {
    const kept = compactDailyRows(season().daily_batting, 'batter', keptDays);
    assert.deepEqual(
      kept.map((r) => r.batter),
      ['Kept', 'Kept']
    );
  });

  it('drops a rostered player on a day nobody held him', () => {
    const rows = [{ date: '2026-05-09', batter: 'Kept' }];
    assert.deepEqual(compactDailyRows(rows, 'batter', keptDays), []);
  });

  it('survives an absent array', () => {
    assert.deepEqual(compactDailyRows(null, 'batter', keptDays), []);
  });
});

describe('compactWeeklyRows', () => {
  it('is looser than the daily filter, by season not by day', () => {
    const kept = compactWeeklyRows(season().weekly_batting, 'batter', keptPlayers);
    assert.deepEqual(
      kept.map((r) => r.batter),
      ['Kept']
    );
  });
});

describe('trimStatRow', () => {
  it('drops cumulative when it duplicates delta', () => {
    const r = trimStatRow({ batter: 'X', delta: { hr: 1 }, cumulative: { hr: 1 } });
    assert.equal(r.cumulative, undefined);
    assert.deepEqual(r.delta, { hr: 1 });
  });

  it('KEEPS cumulative when it genuinely differs — the gsheets running total', () => {
    const r = trimStatRow({ batter: 'X', delta: { hr: 1 }, cumulative: { hr: 4 } });
    assert.deepEqual(r.cumulative, { hr: 4 });
  });

  it('drops zero-valued stat keys, which every reader already defaults', () => {
    const r = trimStatRow({ batter: 'X', hr: 1, r: 0, sb: 0, weekly_score: 14 });
    assert.deepEqual(r, { batter: 'X', hr: 1, weekly_score: 14 });
  });

  it('never drops a structural field that happens to be zero', () => {
    const r = trimStatRow({ batter: 'X', weekly_score: 0, total_score: 0, manager: null, game_id: 0 });
    assert.equal('weekly_score' in r, true);
    assert.equal('total_score' in r, true);
    assert.equal('manager' in r, true);
    assert.equal('game_id' in r, true);
  });

  it('does not mutate its input', () => {
    const row = { batter: 'X', hr: 0, delta: { hr: 1 }, cumulative: { hr: 1 } };
    trimStatRow(row);
    assert.equal(row.hr, 0);
    assert.deepEqual(row.cumulative, { hr: 1 });
  });
});

describe('restrictMap', () => {
  it('keeps only the kept names', () => {
    assert.deepEqual(restrictMap({ Kept: 'NYY', Nobody: 'BOS' }, keptPlayers), { Kept: 'NYY' });
  });
  it('answers empty for nothing', () => {
    assert.deepEqual(restrictMap(null, keptPlayers), {});
  });
});

describe('compactSeason — the tiers are cumulative', () => {
  const args = { keptDays, keptPlayers };

  it('tier 1 touches the dailies only', () => {
    const out = compactSeason(season(), { ...args, tier: 1 });
    assert.equal(out.daily_batting.length, 2);
    assert.equal(out.daily_pitching.length, 1);
    assert.equal(out.weekly_batting.length, 2, 'weeklies are untouched at tier 1');
    assert.deepEqual(out.playoff_odds, { day: 'x' }, 'caches are untouched at tier 1');
  });

  it('tier 2 adds the weeklies', () => {
    const out = compactSeason(season(), { ...args, tier: 2 });
    assert.equal(out.weekly_batting.length, 1);
    assert.equal(out.weekly_pitching.length, 1);
    assert.deepEqual(out.playoff_odds, { day: 'x' });
  });

  it('tier 3 drops the derived caches and shrinks the pools and maps', () => {
    const out = compactSeason(season(), { ...args, tier: 3 });
    assert.equal(out.playoff_odds, undefined);
    assert.equal(out.bracket_odds, undefined);
    assert.equal(out.hot_takes, undefined);
    assert.deepEqual(out.batters_pool, ['Kept']);
    assert.deepEqual(out.pitchers_pool, ['Arm']);
    assert.deepEqual(out.batters_team, { Kept: 'NYY' });
    assert.deepEqual(out.mlb_ids, { Kept: 1, Arm: 3 });
  });

  it('tier 3 keeps the LAST score snapshot — the certified-totals record', () => {
    const out = compactSeason(season(), { ...args, tier: 3 });
    assert.equal(out.score_snapshots.length, ARCHIVE_KEEP_SNAPSHOTS);
    assert.deepEqual(out.score_snapshots, [{ date: 'c' }]);
    assert.equal(out.upload_log.length, ARCHIVE_KEEP_UPLOADS);
    assert.deepEqual(out.upload_log[0], { n: 4 });
  });

  it('tier 4 trims every remaining row', () => {
    const out = compactSeason(season(), { ...args, tier: 4 });
    assert.equal(out.daily_batting[0].cumulative, undefined);
    assert.deepEqual(out.daily_batting[0].delta, { hr: 1 });
    assert.equal('sb' in out.weekly_batting[0], false);
    assert.equal(out.weekly_batting[0].weekly_score, 14);
  });

  it('never touches the scoring invariant, at any tier', () => {
    for (const tier of [1, 2, 3, 4]) {
      const before = season();
      const out = compactSeason(before, { ...args, tier });
      for (const key of ['roster_dates', 'rosters', 'swaps', 'schedule_dates', 'season_closed', 'status']) {
        assert.deepEqual(out[key], before[key], `tier ${tier} must not touch ${key}`);
      }
    }
  });

  it('does not mutate the season it was handed', () => {
    const before = season();
    compactSeason(before, { ...args, tier: 4 });
    assert.equal(before.daily_batting.length, 3);
    assert.deepEqual(before.playoff_odds, { day: 'x' });
    assert.deepEqual(before.daily_batting[0].cumulative, { hr: 1, r: 0 });
  });

  it('with empty keep-sets, removes every stat row rather than throwing', () => {
    const out = compactSeason(season(), { tier: 4 });
    assert.deepEqual(out.daily_batting, []);
    assert.deepEqual(out.weekly_batting, []);
  });
});

describe('archiveSummary', () => {
  it('counts rows and bytes on both sides', () => {
    const before = season();
    const after = compactSeason(before, { keptDays, keptPlayers, tier: 4 });
    const s = archiveSummary(before, after);
    assert.equal(s.rows.daily_batting.before, 3);
    assert.equal(s.rows.daily_batting.after, 2);
    assert.equal(s.rows_before, 3 + 2 + 2 + 1);
    assert.ok(s.bytes_after < s.bytes_before);
    assert.match(s.reduction, /^\d+(\.\d+)?%$/);
  });
});
