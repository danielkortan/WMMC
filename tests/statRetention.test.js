import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STAT_RETENTION,
  RETENTION_MIN_KEEP,
  buildRetentionFilter,
  retainPlayers,
  retainsPlayer,
  retentionKey,
  retentionSummary,
  seasonRetentionNames,
  statRetentionMode,
} from '../js/statRetention.js';

// A season big enough to clear RETENTION_MIN_KEEP, so tests about the filter's DECISIONS are not
// silently answered by the too-small-to-trust fallback.
function seasonWith(extra = {}) {
  // Distinct LETTER names: retentionKey strips digits, so `Filler 1`/`Filler 2` would collapse
  // into one key and the season would sit below the floor.
  const filler = {};
  for (let i = 0; i < RETENTION_MIN_KEEP + 5; i++) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    filler[`Filler Player${suffix}`] = { add_date: '2026-05-04' };
  }
  return {
    stat_retention: 'rostered',
    roster_dates: { 'Daniel Kortan': { 'PP1|Week 1': filler } },
    ...extra,
  };
}

describe('statRetentionMode', () => {
  it('defaults to all, which is the pre-existing behaviour', () => {
    assert.equal(statRetentionMode({}), 'all');
    assert.equal(statRetentionMode(null), 'all');
    assert.equal(DEFAULT_STAT_RETENTION, 'all');
  });

  it('ignores a mode it does not recognise rather than filtering on it', () => {
    assert.equal(statRetentionMode({ stat_retention: 'rosterd' }), 'all');
    assert.equal(statRetentionMode({ stat_retention: 'rostered' }), 'rostered');
  });
});

describe('retentionKey', () => {
  it('is loose enough that an accent or a suffix cannot drop a rostered player', () => {
    assert.equal(retentionKey('José Ramírez'), retentionKey('Jose Ramirez'));
    assert.equal(retentionKey('Ronald Acuña Jr.'), retentionKey('Ronald Acuna'));
    assert.equal(retentionKey('  Aaron   Judge '), 'aaron judge');
  });

  it('answers empty for the absent player rather than throwing', () => {
    assert.equal(retentionKey(null), '');
    assert.equal(retentionKey(undefined), '');
    assert.equal(retentionKey(''), '');
  });
});

describe('seasonRetentionNames', () => {
  it('reads the roster arrays', () => {
    const names = seasonRetentionNames({
      rosters: { 'Daniel Kortan': { 'PP1|Week 1': { batters: ['Aaron Judge'], pitchers: ['Tarik Skubal'] } } },
    });
    assert.ok(names.has('aaron judge'));
    assert.ok(names.has('tarik skubal'));
  });

  it('reads roster_dates, which is the authority the others are caches of', () => {
    const names = seasonRetentionNames({
      roster_dates: { 'Alex Thalacker': { 'QF|Week 1': { 'Kyle Karros': { add_date: '2026-08-04' } } } },
    });
    assert.ok(names.has('kyle karros'));
  });

  it('keeps BOTH sides of a swap, and keeps a swap that is still pending', () => {
    const names = seasonRetentionNames({
      swaps: [
        { status: 'approved', player_in: 'Ryan Weathers', player_out: 'Bryce Elder' },
        { status: 'pending', player_in: 'Ian Seymour', player_out: 'Sandy Alcantara' },
      ],
    });
    // The pending one is the point: it is approved later and can be stamped with a date that has
    // already gone by, so those rows have to exist before anyone knows the swap will be allowed.
    assert.ok(names.has('ian seymour'));
    assert.ok(names.has('sandy alcantara'));
    assert.ok(names.has('ryan weathers'));
    assert.ok(names.has('bryce elder'));
  });

  it('reads initial and per-period submissions', () => {
    const names = seasonRetentionNames({
      initial_submissions: { 'Joey Auclair': { batters: ['Juan Soto'], pitchers: [] } },
      period_submissions: { PP2: { 'Austin Johnson': { batters: [], pitchers: ['Bryce Elder'] } } },
    });
    assert.ok(names.has('juan soto'));
    assert.ok(names.has('bryce elder'));
  });

  it('survives a season with none of those keys', () => {
    assert.equal(seasonRetentionNames({}).size, 0);
    assert.equal(seasonRetentionNames(null).size, 0);
  });
});

describe('buildRetentionFilter', () => {
  it('is inactive while the mode is all, so nothing changes until it is turned on', () => {
    const f = buildRetentionFilter(seasonWith({ stat_retention: 'all' }));
    assert.equal(f.active, false);
    assert.equal(f.mode, 'all');
    assert.equal(retainsPlayer(f, 'Nobody At All'), true);
  });

  it('is inactive on a keep-set too small to trust, and says why', () => {
    const f = buildRetentionFilter({
      stat_retention: 'rostered',
      rosters: { 'Daniel Kortan': { 'PP1|Week 1': { batters: ['Aaron Judge'], pitchers: [] } } },
    });
    assert.equal(f.active, false);
    assert.match(f.reason, /below the \d+ floor/);
    // A half-loaded season must store everything, not nothing.
    assert.equal(retainsPlayer(f, 'Aaron Judge'), true);
    assert.equal(retainsPlayer(f, 'Some Free Agent'), true);
  });

  it('keeps the rostered and drops the never-rostered once it is active', () => {
    const sd = seasonWith({
      rosters: { 'Daniel Kortan': { 'PP1|Week 1': { batters: ['Aaron Judge'], pitchers: [] } } },
    });
    const f = buildRetentionFilter(sd);
    assert.equal(f.active, true);
    assert.equal(retainsPlayer(f, 'Aaron Judge'), true);
    assert.equal(retainsPlayer(f, 'Filler Playerad'), true);
    assert.equal(retainsPlayer(f, 'Some Free Agent'), false);
  });

  it('matches a stat row spelled differently from the roster', () => {
    const sd = seasonWith({
      rosters: { 'Daniel Kortan': { 'PP1|Week 1': { batters: ['Ronald Acuna Jr.'], pitchers: [] } } },
    });
    const f = buildRetentionFilter(sd);
    assert.equal(retainsPlayer(f, 'Ronald Acuña Jr.'), true);
  });
});

describe('retainsPlayer', () => {
  it('keeps everything when handed nothing at all', () => {
    assert.equal(retainsPlayer(null, 'Aaron Judge'), true);
    assert.equal(retainsPlayer({ active: true, names: null }, 'Aaron Judge'), true);
  });
});

describe('retainPlayers', () => {
  it('adds names that survive every later filter, and is idempotent', () => {
    const sd = {};
    assert.deepEqual(retainPlayers(sd, ['Roman Anthony']), ['Roman Anthony']);
    assert.deepEqual(retainPlayers(sd, ['Roman Anthony']), []);
    assert.deepEqual(sd.held_players, ['Roman Anthony']);
  });

  it('de-duplicates on the match key, not the spelling', () => {
    const sd = { held_players: ['Jose Ramirez'] };
    assert.deepEqual(retainPlayers(sd, ['José Ramírez']), []);
  });

  it('puts a held player in the keep-set', () => {
    const sd = seasonWith({ held_players: ['Roman Anthony'] });
    assert.equal(retainsPlayer(buildRetentionFilter(sd), 'Roman Anthony'), true);
  });

  it('ignores blanks', () => {
    const sd = {};
    assert.deepEqual(retainPlayers(sd, ['', null, undefined]), []);
    assert.equal(sd.held_players, undefined);
  });
});

describe('retentionSummary', () => {
  it('reports the mode, the keep-set and what was skipped', () => {
    const f = buildRetentionFilter(seasonWith());
    assert.deepEqual(retentionSummary(f, { batting: 900, pitching: 400 }), {
      mode: 'rostered',
      active: true,
      keep_set: f.size,
      reason: null,
      skipped_batting: 900,
      skipped_pitching: 400,
    });
  });

  it('answers for a run that had no filter at all', () => {
    assert.deepEqual(retentionSummary(null, null), {
      mode: 'all',
      active: false,
      keep_set: 0,
      reason: null,
      skipped_batting: 0,
      skipped_pitching: 0,
    });
  });
});
