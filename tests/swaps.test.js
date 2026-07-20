import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSwapLimit, FREE_SWAP_REASON, PLAYOFF_LIMITED_REASONS } from '../js/swaps.js';

const swap = (over = {}) => ({
  manager: 'Alice',
  reason: FREE_SWAP_REASON,
  status: 'approved',
  round: 'PP1',
  swap_date: '2026-05-01',
  ...over,
});

describe('checkSwapLimit — pool play', () => {
  it('allows the first Free Swap of a PP round', () => {
    assert.equal(checkSwapLimit([], 'Alice', FREE_SWAP_REASON, 'PP1'), null);
  });

  it('blocks a second Free Swap in the same PP round', () => {
    const err = checkSwapLimit([swap()], 'Alice', FREE_SWAP_REASON, 'PP1');
    assert.match(err, /already used your Free Swap for Pool Play 1/);
  });

  it('counts a pending Free Swap against the slot', () => {
    const err = checkSwapLimit([swap({ status: 'pending' })], 'Alice', FREE_SWAP_REASON, 'PP1');
    assert.match(err, /already used your Free Swap/);
  });

  it('refunds the slot for denied and undone Free Swaps', () => {
    const swaps = [swap({ status: 'denied' }), swap({ status: 'undone' })];
    assert.equal(checkSwapLimit(swaps, 'Alice', FREE_SWAP_REASON, 'PP1'), null);
  });

  it('scopes the Free Swap to its own PP round', () => {
    assert.equal(checkSwapLimit([swap()], 'Alice', FREE_SWAP_REASON, 'PP2'), null);
  });

  it("ignores another manager's Free Swap", () => {
    assert.equal(checkSwapLimit([swap({ manager: 'Bob' })], 'Alice', FREE_SWAP_REASON, 'PP1'), null);
  });

  it('leaves IL, Drop, and Trade swaps unlimited', () => {
    const swaps = [
      swap({ reason: 'IL Swap' }),
      swap({ reason: 'IL Swap' }),
      swap({ reason: 'Drop Swap' }),
      swap({ reason: 'Trade Swap' }),
    ];
    for (const reason of ['IL Swap', 'Drop Swap', 'Trade Swap']) {
      assert.equal(checkSwapLimit(swaps, 'Alice', reason, 'PP1'), null);
    }
  });

  it('excludes commissioner records that carry no round field', () => {
    const swaps = [swap({ reason: 'Drop Swap', round: undefined }), swap({ round: undefined })];
    assert.equal(checkSwapLimit(swaps, 'Alice', FREE_SWAP_REASON, 'PP1'), null);
  });
});

describe('checkSwapLimit — playoffs', () => {
  it('allows the first Free/Drop/Trade swap of a round', () => {
    for (const reason of PLAYOFF_LIMITED_REASONS) {
      assert.equal(checkSwapLimit([], 'Alice', reason, 'QF'), null);
    }
  });

  it('shares one slot per round across Free, Drop, and Trade', () => {
    const used = [swap({ round: 'QF', reason: 'Drop Swap' })];
    for (const reason of PLAYOFF_LIMITED_REASONS) {
      const err = checkSwapLimit(used, 'Alice', reason, 'QF');
      assert.match(err, /one Free\/Drop\/Trade swap for Quarterfinals/);
      assert.match(err, /Drop Swap on 2026-05-01/);
      assert.match(err, /Only IL swaps remain/);
    }
  });

  it('keeps IL swaps unlimited even after the slot is used', () => {
    const used = [swap({ round: 'SF', reason: 'Trade Swap' }), swap({ round: 'SF', reason: 'IL Swap' })];
    assert.equal(checkSwapLimit(used, 'Alice', 'IL Swap', 'SF'), null);
  });

  it('does not let an IL swap consume the Free/Drop/Trade slot', () => {
    const used = [swap({ round: 'Finals', reason: 'IL Swap' })];
    assert.equal(checkSwapLimit(used, 'Alice', 'Drop Swap', 'Finals'), null);
  });

  it('scopes the slot to its own playoff round', () => {
    const used = [swap({ round: 'QF', reason: 'Drop Swap' })];
    assert.equal(checkSwapLimit(used, 'Alice', 'Drop Swap', 'SF'), null);
  });

  it('spells out the round label in the error', () => {
    const mk = (round) => checkSwapLimit([swap({ round, reason: 'Drop Swap' })], 'Alice', 'Drop Swap', round);
    assert.match(mk('QF'), /Quarterfinals/);
    assert.match(mk('SF'), /Semifinals/);
    assert.match(mk('Finals'), /the Finals/);
  });
});

describe('checkSwapLimit — other rounds', () => {
  it('applies no limit for an unknown round', () => {
    assert.equal(checkSwapLimit([swap()], 'Alice', FREE_SWAP_REASON, 'Unknown'), null);
  });
});
