import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSVLine, findColumn, parseNum } from '../js/csv.js';

describe('parseCSVLine', () => {
  it('parses simple comma-separated values', () => {
    assert.deepEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('handles quoted fields', () => {
    assert.deepEqual(parseCSVLine('"hello","world"'), ['hello', 'world']);
  });

  it('handles commas inside quotes', () => {
    assert.deepEqual(parseCSVLine('"last, first",value'), ['last, first', 'value']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    assert.deepEqual(parseCSVLine('"he said ""hi""",ok'), ['he said "hi"', 'ok']);
  });

  it('handles empty fields', () => {
    assert.deepEqual(parseCSVLine('a,,c'), ['a', '', 'c']);
  });

  it('handles single value', () => {
    assert.deepEqual(parseCSVLine('hello'), ['hello']);
  });

  it('handles empty string', () => {
    assert.deepEqual(parseCSVLine(''), ['']);
  });
});

describe('findColumn', () => {
  it('finds column by exact name match (case-insensitive)', () => {
    const row = { 'HR': '5', 'RBI': '3' };
    assert.equal(findColumn(row, ['hr', 'HR']), '5');
  });

  it('finds column by alias', () => {
    const row = { 'home_runs': '5' };
    assert.equal(findColumn(row, ['hr', 'HR', 'home_runs']), '5');
  });

  it('returns null when no match found', () => {
    const row = { 'Name': 'Player' };
    assert.equal(findColumn(row, ['hr', 'HR']), null);
  });

  it('returns first matching column', () => {
    const row = { 'Player': 'Alice', 'Name': 'Bob' };
    assert.equal(findColumn(row, ['player', 'name']), 'Alice');
  });
});

describe('parseNum', () => {
  it('parses integers', () => {
    assert.equal(parseNum('42'), 42);
  });

  it('parses floats', () => {
    assert.equal(parseNum('3.14'), 3.14);
  });

  it('returns 0 for NaN values', () => {
    assert.equal(parseNum('abc'), 0);
  });

  it('returns 0 for empty string', () => {
    assert.equal(parseNum(''), 0);
  });

  it('returns 0 for undefined', () => {
    assert.equal(parseNum(undefined), 0);
  });

  it('handles negative numbers', () => {
    assert.equal(parseNum('-5.5'), -5.5);
  });
});
