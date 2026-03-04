import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, fmtDec, fmtDateISO, fmtDateRangeShort, weekIndexFromKey, getInitials, parseNum } from '../js/utils.js';

describe('fmt', () => {
  it('formats whole numbers with locale', () => {
    const result = fmt(1234);
    assert.ok(result.includes('1') && result.includes('234'));
  });

  it('formats decimals', () => {
    const result = fmt(45.5);
    assert.ok(result.includes('45'));
  });

  it('returns dash for null', () => {
    assert.equal(fmt(null), '-');
  });

  it('returns dash for empty string', () => {
    assert.equal(fmt(''), '-');
  });

  it('returns dash for "None"', () => {
    assert.equal(fmt('None'), '-');
  });

  it('returns non-numeric strings as-is', () => {
    assert.equal(fmt('hello'), 'hello');
  });
});

describe('fmtDec', () => {
  it('formats decimals', () => {
    const result = fmtDec(3.14);
    assert.ok(result.includes('3'));
  });

  it('returns "0" for null', () => {
    assert.equal(fmtDec(null), '0');
  });

  it('returns "0" for empty string', () => {
    assert.equal(fmtDec(''), '0');
  });
});

describe('fmtDateISO', () => {
  it('formats date as YYYY-MM-DD', () => {
    const d = new Date(2025, 5, 15); // June 15, 2025
    assert.equal(fmtDateISO(d), '2025-06-15');
  });

  it('pads single-digit months and days', () => {
    const d = new Date(2025, 0, 5); // Jan 5, 2025
    assert.equal(fmtDateISO(d), '2025-01-05');
  });
});

describe('fmtDateRangeShort', () => {
  it('formats same-month range', () => {
    const result = fmtDateRangeShort('2025-06-09', '2025-06-15');
    assert.equal(result, 'Jun 9 – 15');
  });

  it('formats cross-month range', () => {
    const result = fmtDateRangeShort('2025-06-30', '2025-07-06');
    assert.equal(result, 'Jun 30 – Jul 6');
  });
});

describe('weekIndexFromKey', () => {
  it('finds PP1 Week 1 at index 0', () => {
    assert.equal(weekIndexFromKey('PP1', 'Week 1'), 0);
  });

  it('finds PP2 Week 1 at index 5', () => {
    assert.equal(weekIndexFromKey('PP2', 'Week 1'), 5);
  });

  it('finds QF Week 1 at index 10', () => {
    assert.equal(weekIndexFromKey('QF', 'Week 1'), 10);
  });

  it('finds Finals Week 2 at index 15', () => {
    assert.equal(weekIndexFromKey('Finals', 'Week 2'), 15);
  });

  it('returns -1 for invalid round/week', () => {
    assert.equal(weekIndexFromKey('Invalid', 'Week 1'), -1);
  });
});

describe('getInitials', () => {
  it('extracts initials from full name', () => {
    assert.equal(getInitials('John Smith'), 'JS');
  });

  it('handles single name', () => {
    assert.equal(getInitials('John'), 'JO');
  });

  it('handles three-part name (first + last)', () => {
    assert.equal(getInitials('John Middle Smith'), 'JS');
  });

  it('returns ? for empty name', () => {
    assert.equal(getInitials(''), '?');
  });

  it('returns ? for null', () => {
    assert.equal(getInitials(null), '?');
  });
});

describe('parseNum', () => {
  it('parses valid numbers', () => {
    assert.equal(parseNum('42'), 42);
    assert.equal(parseNum('3.14'), 3.14);
  });

  it('returns 0 for non-numbers', () => {
    assert.equal(parseNum('abc'), 0);
    assert.equal(parseNum(undefined), 0);
  });
});
