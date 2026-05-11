import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSVLine, findColumn } from '../js/csv.js';

describe('parseCSVLine', () => {
  it('splits a simple comma-separated line', () => {
    assert.deepEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('preserves commas inside quoted fields', () => {
    assert.deepEqual(parseCSVLine('"Doe, John",42'), ['Doe, John', '42']);
  });

  it('handles escaped quotes within quoted fields', () => {
    assert.deepEqual(parseCSVLine('"He said ""hi""",x'), ['He said "hi"', 'x']);
  });

  it('preserves empty fields', () => {
    assert.deepEqual(parseCSVLine('a,,b'), ['a', '', 'b']);
    assert.deepEqual(parseCSVLine(',,'), ['', '', '']);
  });

  it('handles a single-field line', () => {
    assert.deepEqual(parseCSVLine('alone'), ['alone']);
  });
});

describe('findColumn', () => {
  it('finds a column by exact name (case-insensitive)', () => {
    const row = { Name: 'Dan', Team: 'KC' };
    assert.equal(findColumn(row, ['name']), 'Dan');
    assert.equal(findColumn(row, ['TEAM']), 'KC');
  });

  it('returns the first matching variant', () => {
    const row = { Player: 'Whit' };
    assert.equal(findColumn(row, ['name', 'player', 'batter']), 'Whit');
  });

  it('returns null when no variant matches', () => {
    const row = { Foo: 1 };
    assert.equal(findColumn(row, ['name', 'player']), null);
  });
});
