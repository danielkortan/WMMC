import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc,
  jsStr,
  parseNum,
  fmt,
  fmtDec,
  getInitials,
  fmtDateISO,
  normalizeName,
  parseServerTimestamp,
  shortManagerNames,
  shortenManagerNamesInSlack,
} from '../js/utils.js';

describe('esc', () => {
  it('escapes the five HTML-sensitive characters', () => {
    assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    assert.equal(esc('a & b\'s "c"'), 'a &amp; b&#39;s &quot;c&quot;');
  });

  it('returns empty string for null / undefined', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });

  it('passes plain strings through unchanged', () => {
    assert.equal(esc('Whit Merrifield'), 'Whit Merrifield');
  });
});

describe('jsStr', () => {
  it('escapes backslashes and single quotes for JS string literals', () => {
    assert.equal(jsStr("O'Neill"), "O\\'Neill");
    assert.equal(jsStr('back\\slash'), 'back\\\\slash');
  });

  it('returns empty string for null / undefined', () => {
    assert.equal(jsStr(null), '');
    assert.equal(jsStr(undefined), '');
  });
});

describe('parseNum', () => {
  it('parses numeric strings', () => {
    assert.equal(parseNum('3.14'), 3.14);
    assert.equal(parseNum('42'), 42);
  });

  it('returns 0 for non-numeric input', () => {
    assert.equal(parseNum(''), 0);
    assert.equal(parseNum('abc'), 0);
    assert.equal(parseNum(null), 0);
    assert.equal(parseNum(undefined), 0);
  });

  it('passes numbers through', () => {
    assert.equal(parseNum(5), 5);
    assert.equal(parseNum(-2.5), -2.5);
  });
});

describe('fmt', () => {
  it('returns "-" for blank / null / "None"', () => {
    assert.equal(fmt(null), '-');
    assert.equal(fmt(''), '-');
    assert.equal(fmt('None'), '-');
  });

  it('formats integers without decimals', () => {
    assert.equal(fmt(42), '42');
    assert.equal(fmt(1000), '1,000');
  });

  it('formats decimals with up to 2 fractional digits', () => {
    assert.equal(fmt(12.5), '12.5');
    assert.equal(fmt(12.345), '12.35');
  });

  it('adds the 69 easter egg', () => {
    assert.equal(fmt(69), '69 ❤️');
    assert.equal(fmt(69.5), '69.5 ❤️');
  });

  it('passes non-numeric strings through', () => {
    assert.equal(fmt('TBD'), 'TBD');
  });
});

describe('fmtDec', () => {
  it('returns "0" for blank input', () => {
    assert.equal(fmtDec(''), '0');
    assert.equal(fmtDec(null), '0');
  });

  it('formats with up to 2 fractional digits', () => {
    assert.equal(fmtDec(7), '7');
    assert.equal(fmtDec(7.123), '7.12');
  });
});

describe('getInitials', () => {
  it('returns the first letter of first + last name', () => {
    assert.equal(getInitials('Dan Kortan'), 'DK');
    assert.equal(getInitials('whit merrifield'), 'WM');
  });

  it('uses first 2 chars of a single-word name', () => {
    assert.equal(getInitials('Madonna'), 'MA');
  });

  it('returns "?" for blank input', () => {
    assert.equal(getInitials(''), '?');
    assert.equal(getInitials(null), '?');
  });

  it('handles middle names by skipping them', () => {
    assert.equal(getInitials('Cal Quantrill Jr'), 'CJ');
  });
});

describe('shortManagerNames', () => {
  it('shortens to the first name when no two managers share one', () => {
    const map = shortManagerNames(['Daniel Kortan', 'Jamie Rogers', 'Alex Thalacker']);
    assert.deepEqual(map, {
      'Daniel Kortan': 'Daniel',
      'Jamie Rogers': 'Jamie',
      'Alex Thalacker': 'Alex',
    });
  });

  it('adds a last initial only to the managers who share a first name', () => {
    const map = shortManagerNames(['Ryan Sullivan', 'Ryan Courville', 'Jamie Rogers']);
    assert.equal(map['Ryan Sullivan'], 'Ryan S.');
    assert.equal(map['Ryan Courville'], 'Ryan C.');
    assert.equal(map['Jamie Rogers'], 'Jamie');
  });

  it('keeps full names when even the last initial would collide', () => {
    const map = shortManagerNames(['Ryan Sullivan', 'Ryan Smith', 'Ryan Courville']);
    assert.equal(map['Ryan Sullivan'], 'Ryan Sullivan');
    assert.equal(map['Ryan Smith'], 'Ryan Smith');
    // ...but the one whose initial is still unique keeps the short form.
    assert.equal(map['Ryan Courville'], 'Ryan C.');
  });

  it('handles single-word names, extra whitespace and duplicates', () => {
    const map = shortManagerNames(['  Whit  ', 'Whit', 'Cam McCallum']);
    assert.equal(map['Whit'], 'Whit');
    assert.equal(map['Cam McCallum'], 'Cam');
    assert.equal(Object.keys(map).length, 2);
  });

  it('ignores blank and non-string entries', () => {
    assert.deepEqual(shortManagerNames(['', null, undefined, 42, 'Cam McCallum']), { 'Cam McCallum': 'Cam' });
    assert.deepEqual(shortManagerNames([]), {});
    assert.deepEqual(shortManagerNames(null), {});
  });

  it('gives two managers with the same first name but only one surname word each a distinct label', () => {
    const map = shortManagerNames(['Alex Thalacker', 'Alex Johnson']);
    assert.equal(map['Alex Thalacker'], 'Alex T.');
    assert.equal(map['Alex Johnson'], 'Alex J.');
  });
});

describe('normalizeName', () => {
  it('matches accent variants of the same name', () => {
    assert.equal(normalizeName('Ronald Acuna Jr.'), normalizeName('Ronald Acuña Jr.'));
    assert.equal(normalizeName('Ivan Herrera'), normalizeName('Iván Herrera'));
  });

  it('strips generational suffixes and punctuation', () => {
    assert.equal(normalizeName('Ronald Acuña Jr.'), 'ronald acuna');
    assert.equal(normalizeName('Fernando Tatis Jr'), 'fernando tatis');
    assert.equal(normalizeName('Cal Ripken III'), 'cal ripken');
  });

  it('lowercases and collapses whitespace', () => {
    assert.equal(normalizeName('  Max   Muncy '), 'max muncy');
  });

  it('keeps team-disambiguated pool keys distinct', () => {
    assert.notEqual(normalizeName('Max Muncy (LAD)'), normalizeName('Max Muncy (ATH)'));
    assert.notEqual(normalizeName('Max Muncy (LAD)'), normalizeName('Max Muncy'));
  });

  it('does not conflate genuinely different first names', () => {
    assert.notEqual(normalizeName('Nicholas Kurtz'), normalizeName('Nick Kurtz'));
  });
});

describe('parseServerTimestamp', () => {
  it('treats zone-less "YYYY-MM-DD HH:MM:SS" server stamps as UTC', () => {
    const d = parseServerTimestamp('2026-07-05 21:26:00');
    assert.equal(d.toISOString(), '2026-07-05T21:26:00.000Z');
  });

  it('treats zone-less T-form ISO strings as UTC', () => {
    const d = parseServerTimestamp('2026-07-05T21:26:00');
    assert.equal(d.toISOString(), '2026-07-05T21:26:00.000Z');
  });

  it('honors an explicit zone marker instead of appending Z', () => {
    assert.equal(parseServerTimestamp('2026-07-05T21:26:00Z').toISOString(), '2026-07-05T21:26:00.000Z');
    assert.equal(parseServerTimestamp('2026-07-05T17:26:00-04:00').toISOString(), '2026-07-05T21:26:00.000Z');
    assert.equal(parseServerTimestamp('2026-07-05T23:26:00+02:00').toISOString(), '2026-07-05T21:26:00.000Z');
  });

  it('parses full toISOString() output with milliseconds', () => {
    const d = parseServerTimestamp('2026-07-05T21:26:00.123Z');
    assert.equal(d.toISOString(), '2026-07-05T21:26:00.123Z');
  });

  it('returns null for blank, date-only, or unparseable input', () => {
    assert.equal(parseServerTimestamp(null), null);
    assert.equal(parseServerTimestamp(undefined), null);
    assert.equal(parseServerTimestamp(''), null);
    assert.equal(parseServerTimestamp('2026-07-05'), null);
    assert.equal(parseServerTimestamp('not a date T'), null);
  });
});

describe('fmtDateISO', () => {
  it('formats as YYYY-MM-DD with zero padding', () => {
    // Construct date deterministically in local TZ
    const d = new Date(2026, 4, 11); // May 11, 2026 — month is 0-indexed
    assert.equal(fmtDateISO(d), '2026-05-11');
  });

  it('zero-pads single-digit month and day', () => {
    const d = new Date(2026, 0, 3);
    assert.equal(fmtDateISO(d), '2026-01-03');
  });
});

describe('shortenManagerNamesInSlack', () => {
  const map = { 'Ryan Sullivan': 'Ryan S.', 'Ryan Courville': 'Ryan C.', 'Cam McCallum': 'Cam' };

  it('rewrites whole names anywhere in a string', () => {
    assert.equal(shortenManagerNamesInSlack('Cam McCallum beat Ryan Sullivan', map), 'Cam beat Ryan S.');
  });

  it('leaves a bare first name alone, which is what makes the pass idempotent', () => {
    assert.equal(shortenManagerNamesInSlack('Cam beat Ryan S.', map), 'Cam beat Ryan S.');
    const once = shortenManagerNamesInSlack('Cam McCallum beat Ryan Sullivan', map);
    assert.equal(shortenManagerNamesInSlack(once, map), once);
  });

  // The regression this function was pulled out of server.js for. `\b` treats `_` as a word
  // character, and `_` is Slack's italic marker, so an italicised name matched at neither end
  // and stayed long while every other mention of the same manager went short.
  it("shortens a name wrapped in Slack's italic markers", () => {
    assert.equal(shortenManagerNamesInSlack('_Ryan Sullivan had a week._', map), '_Ryan S. had a week._');
    assert.equal(shortenManagerNamesInSlack('_Cam McCallum_', map), '_Cam_');
  });

  it('shortens names against every other bit of Slack markup too', () => {
    assert.equal(shortenManagerNamesInSlack('*Cam McCallum*', map), '*Cam*');
    assert.equal(shortenManagerNamesInSlack('> Cam McCallum: 12 pts', map), '> Cam: 12 pts');
    assert.equal(shortenManagerNamesInSlack('(Ryan Sullivan)', map), '(Ryan S.)');
    assert.equal(shortenManagerNamesInSlack('~Cam McCallum~', map), '~Cam~');
  });

  it('still refuses to match a name glued to letters or digits', () => {
    assert.equal(shortenManagerNamesInSlack('XCam McCallumX', map), 'XCam McCallumX');
    assert.equal(shortenManagerNamesInSlack('9Cam McCallum9', map), '9Cam McCallum9');
  });

  it('swallows a sentence period after an initialled short form', () => {
    assert.equal(shortenManagerNamesInSlack('It was Ryan Sullivan.', map), 'It was Ryan S.');
    // ...and only for the short forms that end in one.
    assert.equal(shortenManagerNamesInSlack('It was Cam McCallum.', map), 'It was Cam.');
  });

  it('walks arrays and every string field of a block object', () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '_Cam McCallum_ leads' }, n: 3 }];
    assert.deepEqual(shortenManagerNamesInSlack(blocks, map), [
      { type: 'section', text: { type: 'mrkdwn', text: '_Cam_ leads' }, n: 3 },
    ]);
  });

  it('passes non-strings and an empty map straight through', () => {
    assert.equal(shortenManagerNamesInSlack('Cam McCallum', {}), 'Cam McCallum');
    assert.equal(shortenManagerNamesInSlack('Cam McCallum', null), 'Cam McCallum');
    assert.equal(shortenManagerNamesInSlack(42, map), 42);
    assert.equal(shortenManagerNamesInSlack(null, map), null);
  });

  it('never half-matches a name that contains another', () => {
    const nested = { 'Ryan Sullivan': 'Ryan S.', 'Ryan Sullivan Jr.': 'Ryan J.' };
    assert.equal(shortenManagerNamesInSlack('_Ryan Sullivan Jr._', nested), '_Ryan J._');
  });

  it('escapes regex metacharacters in a name', () => {
    assert.equal(shortenManagerNamesInSlack('_A.B (C)_', { 'A.B (C)': 'AB' }), '_AB_');
    assert.equal(shortenManagerNamesInSlack('_AXB (C)_', { 'A.B (C)': 'AB' }), '_AXB (C)_');
  });
});
