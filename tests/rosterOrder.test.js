import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orderWithSwapChains } from '../js/rosterOrder.js';

const MGR = 'Daniel';

function swap(out, into, date, extra = {}) {
  return { player_out: out, player_in: into, manager: MGR, status: 'approved', swap_date: date, ...extra };
}

describe('orderWithSwapChains — no swaps', () => {
  it('sorts purely by score, descending', () => {
    const names = ['Low', 'High', 'Mid'];
    const scores = { Low: 1, High: 10, Mid: 5 };
    assert.deepEqual(orderWithSwapChains(names, scores, [], MGR), ['High', 'Mid', 'Low']);
  });

  it('treats a missing score as 0', () => {
    const names = ['Unknown', 'Scored'];
    assert.deepEqual(orderWithSwapChains(names, { Scored: 3 }, [], MGR), ['Scored', 'Unknown']);
  });
});

describe('orderWithSwapChains — chaining', () => {
  it('places a swapped-in player directly beneath the player he replaced', () => {
    const names = ['Webb', 'Harrison', 'Other'];
    const scores = { Webb: 20, Harrison: 2, Other: 10 };
    const swaps = [swap('Webb', 'Harrison', '2026-07-08')];
    // Webb's chain best (20) beats Other (10), so the whole chain floats above Other.
    assert.deepEqual(orderWithSwapChains(names, scores, swaps, MGR), ['Webb', 'Harrison', 'Other']);
  });

  it('a strong swap-in carries its low-scoring predecessor up with it', () => {
    const names = ['Webb', 'Harrison', 'Other'];
    const scores = { Webb: 1, Harrison: 20, Other: 10 };
    const swaps = [swap('Webb', 'Harrison', '2026-07-08')];
    assert.deepEqual(orderWithSwapChains(names, scores, swaps, MGR), ['Webb', 'Harrison', 'Other']);
  });

  it('follows a multi-hop chain A → B → C in swap order', () => {
    const names = ['C', 'A', 'B'];
    const scores = { A: 5, B: 3, C: 1 };
    const swaps = [swap('A', 'B', '2026-06-01'), swap('B', 'C', '2026-07-01')];
    assert.deepEqual(orderWithSwapChains(names, scores, swaps, MGR), ['A', 'B', 'C']);
  });

  it('survives a swap cycle (A → B, then B back → A) without dropping anyone', () => {
    const names = ['A', 'B'];
    const scores = { A: 2, B: 8 };
    const swaps = [swap('A', 'B', '2026-06-01'), swap('B', 'A', '2026-07-01')];
    const ordered = orderWithSwapChains(names, scores, swaps, MGR);
    assert.equal(ordered.length, 2);
    assert.deepEqual([...ordered].sort(), ['A', 'B']);
  });
});

describe('orderWithSwapChains — swap filtering', () => {
  it("ignores other managers' swaps, pending/denied swaps, and non-1-for-1 swaps", () => {
    const names = ['A', 'B'];
    const scores = { A: 1, B: 9 };
    const swaps = [
      swap('A', 'B', '2026-06-01', { manager: 'Someone Else' }),
      swap('A', 'B', '2026-06-02', { status: 'pending' }),
      { player_in: 'B', manager: MGR, status: 'approved', swap_date: '2026-06-03' }, // add-only, no player_out
    ];
    // No qualifying swap pairs them, so plain score order wins.
    assert.deepEqual(orderWithSwapChains(names, scores, swaps, MGR), ['B', 'A']);
  });

  it('ignores swaps whose players are not both in the listing', () => {
    const names = ['A', 'B'];
    const scores = { A: 1, B: 9 };
    const swaps = [swap('A', 'Elsewhere', '2026-06-01')];
    assert.deepEqual(orderWithSwapChains(names, scores, swaps, MGR), ['B', 'A']);
  });

  it('resolves a legacy swap without a manager field via the email callback', () => {
    const names = ['A', 'B'];
    const scores = { A: 1, B: 9 };
    const swaps = [{ player_out: 'A', player_in: 'B', email: 'D@X.COM', status: 'approved', swap_date: '2026-06-01' }];
    const byEmail = (email) => (email === 'D@X.COM' ? MGR : undefined);
    assert.deepEqual(orderWithSwapChains(names, scores, swaps, MGR, byEmail), ['A', 'B']);
  });
});
