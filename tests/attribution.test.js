import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOwner, planReattribution, summarizeReattribution, reattributionLine } from '../js/attribution.js';

const row = (over = {}) => ({
  round: 'SF',
  week: 'Week 2',
  batter: 'Joey Cantillo',
  manager: null,
  weekly_score: 31.1,
  ...over,
});

describe('chooseOwner', () => {
  it('is nobody when no manager held the player', () => {
    assert.deepEqual(chooseOwner({}), { owner: null, contested: false });
    assert.deepEqual(chooseOwner(null), { owner: null, contested: false });
  });

  it('is the sole owner when one manager held him', () => {
    assert.deepEqual(chooseOwner({ 'Jamie Rogers': { start: null, end: null } }), {
      owner: 'Jamie Rogers',
      contested: false,
    });
  });

  // A mid-week handover: dropped by A on the 28th, added by B on the 29th. The label goes to whoever
  // held him at the week's end; manager_scores still splits the points.
  it('gives a shared week to whoever held him last, and flags it contested', () => {
    const res = chooseOwner({
      'Alex Thalacker': { start: null, end: '2026-08-28' },
      'Jamie Rogers': { start: '2026-08-29', end: null },
    });
    assert.deepEqual(res, { owner: 'Jamie Rogers', contested: true });
  });

  it('treats a null start as the week opening, so an explicit later add wins', () => {
    const res = chooseOwner({
      'Whole Week': { start: null, end: null },
      'Added Midweek': { start: '2026-08-29', end: null },
    });
    assert.equal(res.owner, 'Added Midweek');
  });

  it('is deterministic regardless of key order', () => {
    const a = { A: { start: '2026-08-20', end: null }, B: { start: '2026-08-20', end: null } };
    const b = { B: { start: '2026-08-20', end: null }, A: { start: '2026-08-20', end: null } };
    assert.equal(chooseOwner(a).owner, chooseOwner(b).owner);
  });
});

describe('planReattribution', () => {
  const owners = { 'Joey Cantillo': { owner: 'Jamie Rogers', contested: false } };

  // The 8/31 incident: the row was stamped with the wrong manager, so managerWeekSubtotal's
  // wrong-owner gate skipped it for both of them and 31.1 points belonged to nobody.
  it('moves a row stamped with the wrong manager', () => {
    const changes = planReattribution([row({ manager: 'Alex Thalacker' })], 'batter', owners);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'moved');
    assert.equal(changes[0].from, 'Alex Thalacker');
    assert.equal(changes[0].to, 'Jamie Rogers');
    assert.equal(changes[0].weekly_score, 31.1);
  });

  it('claims a row nobody was credited with', () => {
    const changes = planReattribution([row({ manager: null })], 'batter', owners);
    assert.equal(changes[0].kind, 'claimed');
    assert.equal(changes[0].from, null);
  });

  it('releases a row whose player nobody rostered', () => {
    const changes = planReattribution([row({ manager: 'Jamie Rogers' })], 'batter', {});
    assert.equal(changes[0].kind, 'released');
    assert.equal(changes[0].to, null);
  });

  it('reports nothing for a row that is already right', () => {
    assert.deepEqual(planReattribution([row({ manager: 'Jamie Rogers' })], 'batter', owners), []);
  });

  it('carries the type through for pitchers', () => {
    const changes = planReattribution(
      [{ round: 'QF', week: 'Week 1', pitcher: 'Tarik Skubal', manager: null, weekly_score: 40 }],
      'pitcher',
      { 'Tarik Skubal': { owner: 'Anton Capria', contested: false } }
    );
    assert.equal(changes[0].type, 'pitching');
    assert.equal(changes[0].player, 'Tarik Skubal');
  });

  it('handles empty and missing input', () => {
    assert.deepEqual(planReattribution([], 'batter', {}), []);
    assert.deepEqual(planReattribution(null, 'batter', null), []);
  });
});

describe('summarizeReattribution', () => {
  it('separates the three directions and names every release in full', () => {
    const changes = [
      ...planReattribution([row({ manager: null })], 'batter', {
        'Joey Cantillo': { owner: 'Jamie Rogers', contested: false },
      }),
      ...planReattribution([row({ batter: 'Nick Lodolo', manager: 'Jamie Rogers', weekly_score: 12 })], 'batter', {}),
      ...planReattribution([row({ batter: 'Bobby Witt Jr.', manager: 'A', weekly_score: 50 })], 'batter', {
        'Bobby Witt Jr.': { owner: 'B', contested: true },
      }),
    ];
    const s = summarizeReattribution(changes);
    assert.equal(s.total, 3);
    assert.equal(s.claimed, 1);
    assert.equal(s.released, 1);
    assert.equal(s.moved, 1);
    assert.equal(s.contested, 1);
    assert.deepEqual(s.weeks, ['SF|Week 2']);
    // Releases are the only direction that removes points, so they are listed, not counted.
    assert.equal(s.released_rows.length, 1);
    assert.equal(s.released_rows[0].player, 'Nick Lodolo');
  });

  it('is empty for no changes', () => {
    const s = summarizeReattribution([]);
    assert.equal(s.total, 0);
    assert.deepEqual(s.weeks, []);
    assert.deepEqual(s.released_rows, []);
  });
});

describe('reattributionLine', () => {
  it('reads as a sentence for each direction', () => {
    assert.equal(
      reattributionLine({
        round: 'SF',
        week: 'Week 2',
        player: 'Joey Cantillo',
        type: 'batting',
        from: null,
        to: 'Jamie Rogers',
        weekly_score: 31.1,
        kind: 'claimed',
      }),
      'SF Week 2 · Joey Cantillo (batting, 31.1 pts): nobody → Jamie Rogers'
    );
    assert.equal(
      reattributionLine({
        round: 'SF',
        week: 'Week 2',
        player: 'X',
        type: 'pitching',
        from: 'A',
        to: null,
        weekly_score: 0,
        kind: 'released',
      }),
      'SF Week 2 · X (pitching, 0 pts): A → nobody'
    );
    assert.match(
      reattributionLine({
        round: 'QF',
        week: 'Week 1',
        player: 'Y',
        type: 'batting',
        from: 'A',
        to: 'B',
        weekly_score: 5.256,
        kind: 'moved',
        contested: true,
      }),
      /A → B \[shared week\]$/
    );
  });
});
