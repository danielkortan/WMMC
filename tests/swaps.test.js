import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSwapLimit,
  checkSwapEffectiveWindow,
  swapReasonLabel,
  SWAP_REASON_LABELS,
  FREE_SWAP_REASON,
  PLAYOFF_LIMITED_REASONS,
} from '../js/swaps.js';

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

  it('blocks a second swap of the same type in a round', () => {
    const used = [swap({ round: 'QF', reason: 'Drop Swap' })];
    const err = checkSwapLimit(used, 'Alice', 'Drop Swap', 'QF');
    assert.match(err, /already used your Drop Swap for Quarterfinals/);
    assert.match(err, /on 2026-05-01/);
    assert.match(err, /other playoff swaps or an IL swap/);
  });

  it('spells out the Free Swap label without the parenthetical', () => {
    const used = [swap({ round: 'QF', reason: FREE_SWAP_REASON })];
    const err = checkSwapLimit(used, 'Alice', FREE_SWAP_REASON, 'QF');
    assert.match(err, /already used your Free Swap for Quarterfinals/);
  });

  it('allows one each of Free, Drop, and Trade in the same round', () => {
    // Having used Drop and Trade, a Free Swap is still allowed, and vice versa.
    const used = [swap({ round: 'QF', reason: 'Drop Swap' }), swap({ round: 'QF', reason: 'Trade Swap' })];
    assert.equal(checkSwapLimit(used, 'Alice', FREE_SWAP_REASON, 'QF'), null);

    const used2 = [swap({ round: 'QF', reason: FREE_SWAP_REASON }), swap({ round: 'QF', reason: 'Trade Swap' })];
    assert.equal(checkSwapLimit(used2, 'Alice', 'Drop Swap', 'QF'), null);
  });

  it('keeps IL swaps unlimited even after a type is used', () => {
    const used = [swap({ round: 'SF', reason: 'Trade Swap' }), swap({ round: 'SF', reason: 'IL Swap' })];
    assert.equal(checkSwapLimit(used, 'Alice', 'IL Swap', 'SF'), null);
  });

  it('does not let an IL swap consume a Free/Drop/Trade slot', () => {
    const used = [swap({ round: 'Finals', reason: 'IL Swap' })];
    assert.equal(checkSwapLimit(used, 'Alice', 'Drop Swap', 'Finals'), null);
  });

  it('scopes each type slot to its own playoff round', () => {
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

// The 2026 shape this rule was written for: SF Week 2 ends Aug 16, and Aug 17 is the first day of
// the Finals — a new submission period. A swap submitted on Aug 16 with the incoming player's team
// already playing computes add_date = Aug 17, which is a no-op for the Semifinals and an uninvited
// add to the Finals roster.
describe('checkSwapEffectiveWindow', () => {
  it('blocks an add that lands past the round it is charged to', () => {
    const err = checkSwapEffectiveWindow('2026-08-17', '2026-08-16', 'SF', 'Nick Lodolo');
    assert.match(err, /cannot take effect until 2026-08-17/);
    assert.match(err, /the Semifinals ends 2026-08-16/);
    assert.match(err, /Nick Lodolo/);
    assert.match(err, /none of your swaps have been used/);
  });

  it("allows an add on the round's final day", () => {
    assert.equal(checkSwapEffectiveWindow('2026-08-16', '2026-08-16', 'SF', 'Nick Lodolo'), null);
  });

  it('allows a mid-round add that crosses only a WEEK boundary', () => {
    // QF Week 1 ends Jul 26; the add rolls to Jul 27 (QF Week 2), still inside the QF round.
    assert.equal(checkSwapEffectiveWindow('2026-07-27', '2026-08-02', 'QF', 'Aaron Nola'), null);
  });

  it('blocks the same shape at a pool-play boundary', () => {
    // PP1 Week 5 ends Jun 7; an add on Jun 8 belongs to PP2, which starts from its own submission.
    const err = checkSwapEffectiveWindow('2026-06-08', '2026-06-07', 'PP1', 'Joey Cantillo');
    assert.match(err, /Pool Play 1 ends 2026-06-07/);
  });

  it('blocks an add past the end of the Finals', () => {
    const err = checkSwapEffectiveWindow('2026-08-31', '2026-08-30', 'Finals', 'Chris Sale');
    assert.match(err, /the Finals ends 2026-08-30/);
  });

  it('names the incoming player generically when none is given', () => {
    const err = checkSwapEffectiveWindow('2026-08-17', '2026-08-16', 'SF');
    assert.match(err, /the incoming player/);
  });

  it('falls back to the raw round key for an unknown round', () => {
    const err = checkSwapEffectiveWindow('2026-08-17', '2026-08-16', 'XX', 'A B');
    assert.match(err, /XX ends 2026-08-16/);
  });

  it('is inert when either date is missing', () => {
    assert.equal(checkSwapEffectiveWindow('', '2026-08-16', 'SF', 'X'), null);
    assert.equal(checkSwapEffectiveWindow('2026-08-17', null, 'SF', 'X'), null);
  });
});

describe('swapReasonLabel', () => {
  it('shows an IL Swap as IL/RST, since the Restricted List now qualifies', () => {
    assert.equal(swapReasonLabel('IL Swap'), 'IL/RST Swap');
  });

  // The whole point of the map: relabelling the menu must not change what gets written to
  // db.json, because checkSwapLimit and the server's IL gate both compare against the stored
  // string and every historical swap already carries it.
  it('leaves the stored value alone — the map is keyed by it, never replaces it', () => {
    assert.equal(SWAP_REASON_LABELS['IL Swap'], 'IL/RST Swap');
    assert.equal(checkSwapLimit([], 'Alice', 'IL Swap', 'QF'), null);
  });

  it('passes through every reason it has no label for', () => {
    for (const reason of [FREE_SWAP_REASON, 'Drop Swap', 'Trade Swap', 'Commissioner Swap']) {
      assert.equal(swapReasonLabel(reason), reason);
    }
  });

  it('passes through an unknown reason unchanged', () => {
    assert.equal(swapReasonLabel('Some Future Swap'), 'Some Future Swap');
  });

  it('renders a missing reason as an empty string rather than undefined', () => {
    assert.equal(swapReasonLabel(''), '');
    assert.equal(swapReasonLabel(undefined), '');
    assert.equal(swapReasonLabel(null), '');
  });
});
