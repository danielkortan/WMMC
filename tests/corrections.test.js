import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECTION_ROW_LIMIT,
  buildCorrectionRefusalText,
  classifyCorrectionRow,
  correctionRefusalLogLine,
  correctionRowLine,
  correctionVerdictLine,
  fmtCorrectionDelta,
  summarizeCorrectionRows,
} from '../js/corrections.js';

// The row that started all this: Joey Cantillo, SF Week 2 2026. Jamie Rogers held him all week,
// an undone swap left the cached row stamped to the previous owner, and the sweep refused the
// repair every Wednesday because 31.1 > the 15-point ceiling.
const CANTILLO = {
  player: 'Joey Cantillo',
  type: 'pitching',
  storedScore: 31.1,
  resyncScore: 31.1,
  storedManager: 'Alex Thalacker',
  resyncManager: 'Jamie Rogers',
};

const HARRISON = {
  player: 'Kyle Harrison',
  type: 'pitching',
  storedScore: -7.3,
  resyncScore: 2.7,
  storedManager: null,
  resyncManager: null,
};

describe('classifyCorrectionRow', () => {
  it('calls a same-score handover an owner change, not a stat correction', () => {
    const r = classifyCorrectionRow(CANTILLO);
    assert.equal(r.kind, 'owner');
    assert.equal(r.scoreDiff, 0);
    assert.equal(r.ownerChanged, true);
  });

  it('measures an owner change by the whole row, not by its zero delta', () => {
    // The bug this exists to surface: sorting these rows by score delta buries the one that
    // matters, because the row that moved 31.1 points between managers has a delta of 0.
    assert.equal(classifyCorrectionRow(CANTILLO).impact, 31.1);
  });

  it('calls a moved score with a stable owner a stat change', () => {
    const r = classifyCorrectionRow(HARRISON);
    assert.equal(r.kind, 'score');
    assert.equal(r.scoreDiff, 10);
    assert.equal(r.impact, 10);
  });

  it('flags a row that changed both', () => {
    const r = classifyCorrectionRow({ ...CANTILLO, resyncScore: 40 });
    assert.equal(r.kind, 'both');
    assert.equal(r.scoreDiff, 8.9);
    assert.equal(r.impact, 40);
  });

  it('names a created row and a removed one', () => {
    assert.equal(classifyCorrectionRow({ ...HARRISON, existedBefore: false }).kind, 'added');
    assert.equal(classifyCorrectionRow({ ...HARRISON, existsAfter: false }).kind, 'removed');
  });

  it('scores a removed row by what would be lost', () => {
    const r = classifyCorrectionRow({ ...CANTILLO, existsAfter: false });
    assert.equal(r.impact, 31.1);
  });

  it('treats a missing manager and null as the same owner', () => {
    const r = classifyCorrectionRow({ ...HARRISON, storedManager: undefined, resyncManager: null });
    assert.equal(r.ownerChanged, false);
    assert.equal(r.kind, 'score');
  });

  it('drops a row where nothing moved', () => {
    assert.equal(classifyCorrectionRow({ ...CANTILLO, resyncManager: 'Alex Thalacker' }).kind, null);
  });
});

describe('summarizeCorrectionRows', () => {
  it('verdicts a pure attribution week', () => {
    const s = summarizeCorrectionRows([CANTILLO]);
    assert.equal(s.verdict, 'attribution');
    assert.equal(s.ownerMoved, 1);
    assert.equal(s.scoreMoved, 0);
  });

  it('verdicts a pure stats week', () => {
    const s = summarizeCorrectionRows([HARRISON]);
    assert.equal(s.verdict, 'stats');
  });

  it('verdicts a mixed week', () => {
    assert.equal(summarizeCorrectionRows([CANTILLO, HARRISON]).verdict, 'mixed');
  });

  it('says nothing moved when nothing moved', () => {
    const s = summarizeCorrectionRows([{ ...CANTILLO, resyncManager: 'Alex Thalacker' }]);
    assert.equal(s.verdict, 'none');
    assert.equal(s.rows.length, 0);
  });

  it('sorts by what each row can move, so the owner change leads', () => {
    // Cantillo's delta is 0 and Harrison's is 10 — a delta sort would put the 31.1-point
    // handover second and hide the finding under a rounding error.
    const s = summarizeCorrectionRows([HARRISON, CANTILLO]);
    assert.deepEqual(
      s.rows.map((r) => r.player),
      ['Joey Cantillo', 'Kyle Harrison']
    );
  });

  it('tolerates no rows at all', () => {
    assert.equal(summarizeCorrectionRows(undefined).verdict, 'none');
    assert.equal(summarizeCorrectionRows([]).rows.length, 0);
  });
});

describe('correctionRowLine', () => {
  it('leads an owner change with the handover and says the score held', () => {
    const line = correctionRowLine(classifyCorrectionRow(CANTILLO));
    assert.match(line, /Joey Cantillo/);
    assert.match(line, /Alex Thalacker/);
    assert.match(line, /Jamie Rogers/);
    assert.match(line, /score unchanged/);
  });

  it('leads a stat change with the numbers', () => {
    const line = correctionRowLine(classifyCorrectionRow(HARRISON));
    assert.match(line, /-7\.3/);
    assert.match(line, /2\.7/);
    assert.match(line, /\+10/);
    assert.match(line, /owner unchanged/);
  });

  it('names an unowned row rather than printing null', () => {
    const line = correctionRowLine(classifyCorrectionRow({ ...CANTILLO, storedManager: null }));
    assert.match(line, /\(nobody\)/);
    assert.doesNotMatch(line, /null/);
  });
});

describe('correctionVerdictLine', () => {
  it('tells the commissioner an attribution week is a repair, not a risk', () => {
    const line = correctionVerdictLine(summarizeCorrectionRows([CANTILLO]));
    assert.match(line, /OWNER/);
    assert.match(line, /repair/);
  });

  it('tells them a stats week needs a look first', () => {
    const line = correctionVerdictLine(summarizeCorrectionRows([HARRISON]));
    assert.match(line, /SCORE/);
    assert.match(line, /wrong week/);
  });

  it('counts both kinds on a mixed week', () => {
    const line = correctionVerdictLine(summarizeCorrectionRows([CANTILLO, HARRISON]));
    assert.match(line, /1 row\(s\) changed owner and 1 changed score/);
  });
});

describe('buildCorrectionRefusalText', () => {
  const flagged = [
    {
      week: 'SF Week 2',
      maxSwing: 31.1,
      diffs: [{ manager: 'Jamie Rogers', diff: 31.1 }],
      summary: summarizeCorrectionRows([CANTILLO, HARRISON]),
    },
  ];

  it('still says what the old message said', () => {
    const text = buildCorrectionRefusalText(flagged, 15);
    assert.match(text, /refused 1 week\(s\)/);
    assert.match(text, /more than 15 pts/);
    assert.match(text, /Nothing was written/);
    assert.match(text, /SF Week 2/);
    assert.match(text, /Jamie Rogers \+31\.1/);
  });

  it('names the rows behind the swing', () => {
    const text = buildCorrectionRefusalText(flagged, 15);
    assert.match(text, /Joey Cantillo/);
    assert.match(text, /Kyle Harrison/);
  });

  it('degrades to the thin message when rows could not be captured', () => {
    const text = buildCorrectionRefusalText(
      [{ week: 'SF Week 2', diffs: [{ manager: 'Jamie Rogers', diff: 31.1 }] }],
      15
    );
    assert.match(text, /Jamie Rogers \+31\.1/);
    assert.doesNotMatch(text, /owner changed/);
  });

  it('caps the row list and counts the rest', () => {
    const many = Array.from({ length: CORRECTION_ROW_LIMIT + 3 }, (_, i) => ({
      ...HARRISON,
      player: `Player ${i}`,
      resyncScore: 100 - i,
    }));
    const text = buildCorrectionRefusalText(
      [{ week: 'PP1 Week 1', diffs: [{ manager: 'A', diff: 40 }], summary: summarizeCorrectionRows(many) }],
      15
    );
    assert.match(text, /…and 3 more row\(s\)/);
  });

  it('returns nothing when nothing was refused', () => {
    assert.equal(buildCorrectionRefusalText([], 15), '');
    assert.equal(buildCorrectionRefusalText(undefined, 15), '');
  });

  it('handles a week whose swing came from outside its rows', () => {
    const text = buildCorrectionRefusalText(
      [{ week: 'QF Week 1', diffs: [{ manager: 'A', diff: 22 }], summary: summarizeCorrectionRows([]) }],
      15
    );
    assert.match(text, /No stat row moved at all/);
  });
});

describe('correctionRefusalLogLine', () => {
  it('compresses a week to one line with its verdict', () => {
    const line = correctionRefusalLogLine([
      {
        week: 'SF Week 2',
        diffs: [{ manager: 'Jamie Rogers', diff: 31.1 }],
        summary: summarizeCorrectionRows([CANTILLO]),
      },
    ]);
    assert.equal(line, 'SF Week 2 [attribution]: Jamie Rogers +31.1');
  });
});

describe('fmtCorrectionDelta', () => {
  it('signs a positive and leaves a negative alone', () => {
    assert.equal(fmtCorrectionDelta(31.1), '+31.1');
    assert.equal(fmtCorrectionDelta(-7.3), '-7.3');
    assert.equal(fmtCorrectionDelta(0), '0');
  });
});

describe('a week whose rows only appeared or vanished', () => {
  // Neither a stat correction nor an attribution fix. It gets its own verdict because the
  // removal case takes points away silently — and because counting it as "mixed" would print
  // "0 row(s) changed owner and 0 changed score", which is nonsense.
  it('verdicts structural, not mixed', () => {
    const s = summarizeCorrectionRows([
      { ...CANTILLO, existsAfter: false },
      { ...HARRISON, existedBefore: false },
    ]);
    assert.equal(s.verdict, 'structural');
    assert.equal(s.structural, 2);
  });

  it('warns that a removed row takes its points with it', () => {
    const line = correctionVerdictLine(summarizeCorrectionRows([{ ...CANTILLO, existsAfter: false }]));
    assert.match(line, /ADDED or REMOVED/);
    assert.match(line, /takes its points with it/);
    assert.doesNotMatch(line, /0 row\(s\)/);
  });
});
