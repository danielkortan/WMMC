import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLLUP_DRIFT_NAG_DAYS,
  daysBetweenISO,
  recordRollupDriftFlags,
  rollupDriftDueForAlert,
  outstandingRollupDrift,
  rollupDriftCloseBlock,
} from '../js/rollupDrift.js';

const finding = (over = {}) => ({
  manager: 'Jamie Rogers',
  week: 'SF|Week 2',
  certified: 509.05,
  from_daily: 540.15,
  delta: -31.1,
  players: [{ player: 'Joey Cantillo', certified: 0, from_daily: 31.1, delta: -31.1 }],
  ...over,
});

describe('daysBetweenISO', () => {
  it('counts whole days forward', () => {
    assert.equal(daysBetweenISO('2026-08-19', '2026-08-31'), 12);
  });

  it('is zero for the same day and negative going back', () => {
    assert.equal(daysBetweenISO('2026-08-19', '2026-08-19'), 0);
    assert.equal(daysBetweenISO('2026-08-31', '2026-08-19'), -12);
  });

  // A local-time parse would return 0 or 2 across the US DST boundaries; UTC midnight gives 1.
  it('is not thrown by a DST boundary', () => {
    assert.equal(daysBetweenISO('2026-03-07', '2026-03-08'), 1);
    assert.equal(daysBetweenISO('2026-10-31', '2026-11-01'), 1);
  });

  it('returns 0 for a missing date', () => {
    assert.equal(daysBetweenISO(null, '2026-08-31'), 0);
    assert.equal(daysBetweenISO('2026-08-31', undefined), 0);
  });
});

describe('recordRollupDriftFlags', () => {
  it('records a new finding with today as first_seen and nothing alerted yet', () => {
    const sd = {};
    const flags = recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    const f = flags['Jamie Rogers|SF|Week 2'];
    assert.equal(f.first_seen, '2026-08-19');
    assert.equal(f.last_seen, '2026-08-19');
    assert.equal(f.last_alerted, null);
    assert.equal(f.delta, -31.1);
    assert.equal(sd.rollup_drift, flags);
  });

  // The whole point of persisting: the age of a standing problem must be real, not reset by a
  // deploy or a restart the way the old in-memory signature was.
  it('carries first_seen and last_alerted across runs while advancing last_seen', () => {
    const sd = {};
    recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    sd.rollup_drift['Jamie Rogers|SF|Week 2'].last_alerted = '2026-08-19';
    sd.rollup_drift['Jamie Rogers|SF|Week 2'].alerted_delta = -31.1;

    recordRollupDriftFlags(sd, [finding()], '2026-08-31');
    const f = sd.rollup_drift['Jamie Rogers|SF|Week 2'];
    assert.equal(f.first_seen, '2026-08-19');
    assert.equal(f.last_seen, '2026-08-31');
    assert.equal(f.last_alerted, '2026-08-19');
    assert.equal(f.alerted_delta, -31.1);
  });

  it('clears a resolved drift by replacing the map, not merging into it', () => {
    const sd = {};
    recordRollupDriftFlags(sd, [finding(), finding({ manager: 'Alex Thalacker' })], '2026-08-19');
    assert.equal(Object.keys(sd.rollup_drift).length, 2);

    recordRollupDriftFlags(sd, [finding()], '2026-08-20');
    assert.deepEqual(Object.keys(sd.rollup_drift), ['Jamie Rogers|SF|Week 2']);
  });

  it('removes the field entirely when the audit comes back clean', () => {
    const sd = {};
    recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    recordRollupDriftFlags(sd, [], '2026-08-20');
    assert.equal('rollup_drift' in sd, false);
  });

  it('caps the stored player list so one bad week cannot bloat the season', () => {
    const players = Array.from({ length: 20 }, (_, i) => ({ player: `P${i}`, delta: -1 }));
    const sd = {};
    const flags = recordRollupDriftFlags(sd, [finding({ players })], '2026-08-19');
    assert.equal(flags['Jamie Rogers|SF|Week 2'].players.length, 6);
  });
});

describe('rollupDriftDueForAlert', () => {
  const key = 'Jamie Rogers|SF|Week 2';

  it('posts a finding that has never been alerted', () => {
    const sd = {};
    const flags = recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    assert.equal(rollupDriftDueForAlert(flags, '2026-08-19').length, 1);
  });

  // The behaviour the old in-memory de-duplication got right, and the only one it got right.
  it('stays quiet on a second run the same day', () => {
    const sd = {};
    const flags = recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    flags[key].last_alerted = '2026-08-19';
    flags[key].alerted_delta = -31.1;
    assert.equal(rollupDriftDueForAlert(flags, '2026-08-19').length, 0);
  });

  it('stays quiet the next day, while the finding is still fresh', () => {
    const sd = {};
    const flags = recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    flags[key].last_alerted = '2026-08-19';
    flags[key].alerted_delta = -31.1;
    assert.equal(rollupDriftDueForAlert(flags, '2026-08-20').length, 0);
  });

  // The regression this module exists for: under the old rule this returned nothing, forever.
  it('comes back once an unchanged finding has been quiet for the nag window', () => {
    const sd = {};
    const flags = recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    flags[key].last_alerted = '2026-08-19';
    flags[key].alerted_delta = -31.1;

    const due = rollupDriftDueForAlert(flags, '2026-08-22');
    assert.equal(due.length, 1);
    assert.equal(daysBetweenISO(due[0].first_seen, '2026-08-22'), 3);
    assert.equal(ROLLUP_DRIFT_NAG_DAYS, 3);
  });

  it('posts immediately when the number moves, without waiting for the nag window', () => {
    const sd = {};
    recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    sd.rollup_drift[key].last_alerted = '2026-08-19';
    sd.rollup_drift[key].alerted_delta = -31.1;

    const flags = recordRollupDriftFlags(sd, [finding({ delta: -44.2 })], '2026-08-20');
    assert.equal(rollupDriftDueForAlert(flags, '2026-08-20').length, 1);
  });

  it('handles an empty or missing map', () => {
    assert.deepEqual(rollupDriftDueForAlert({}, '2026-08-19'), []);
    assert.deepEqual(rollupDriftDueForAlert(null, '2026-08-19'), []);
  });
});

describe('rollupDriftCloseBlock', () => {
  it('lets a clean season close', () => {
    assert.equal(rollupDriftCloseBlock({}, false), null);
    assert.equal(rollupDriftCloseBlock({ rollup_drift: {} }, false), null);
  });

  // The 2026 season closed over exactly this finding. It no longer can.
  it('blocks a close while a drift stands, naming the week and its age', () => {
    const sd = {};
    recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    const blocked = rollupDriftCloseBlock(sd, false);
    assert.ok(blocked);
    assert.equal(blocked.force_required, true);
    assert.match(blocked.error, /SF\|Week 2/);
    assert.match(blocked.error, /first seen 2026-08-19/);
    assert.match(blocked.error, /off by 31\.1/);
    assert.equal(blocked.rollup_drift.length, 1);
  });

  it('yields to force, so the commissioner can still close on purpose', () => {
    const sd = {};
    recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    assert.equal(rollupDriftCloseBlock(sd, true), null);
  });
});

describe('outstandingRollupDrift', () => {
  it('is empty for a clean season and reports both totals when it is not', () => {
    assert.deepEqual(outstandingRollupDrift({}), []);
    const sd = {};
    recordRollupDriftFlags(sd, [finding()], '2026-08-19');
    assert.deepEqual(outstandingRollupDrift(sd), [
      {
        manager: 'Jamie Rogers',
        week: 'SF|Week 2',
        delta: -31.1,
        certified: 509.05,
        from_daily: 540.15,
        first_seen: '2026-08-19',
        last_seen: '2026-08-19',
      },
    ]);
  });
});
