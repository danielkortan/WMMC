import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtPreviewScore,
  previewHistoryFact,
  previewEdge,
  buildMatchupPreview,
  buildRoundPreviewBlock,
} from '../js/roundPreview.js';

const team = (over = {}) => ({
  name: 'Alice',
  seed: 1,
  playoffPoints: 1200,
  roundPoints: [
    { round: 'QF', points: 610.25 },
    { round: 'SF', points: 589.75 },
  ],
  top: [
    { name: 'Aaron Judge', points: 188.4 },
    { name: 'Tarik Skubal', points: 141 },
  ],
  history: null,
  ...over,
});

describe('fmtPreviewScore', () => {
  it('formats one decimal with separators and drops a trailing .0', () => {
    assert.equal(fmtPreviewScore(1204.55), '1,204.6');
    assert.equal(fmtPreviewScore(1200), '1,200');
    assert.equal(fmtPreviewScore(0), '0');
    assert.equal(fmtPreviewScore(-12.34), '-12.3');
  });

  it('never emits NaN for unusable input', () => {
    assert.equal(fmtPreviewScore(undefined), '0');
    assert.equal(fmtPreviewScore(null), '0');
    assert.equal(fmtPreviewScore('not a number'), '0');
  });
});

describe('previewHistoryFact', () => {
  const hist = (over = {}) => ({
    seasonsPlayed: 5,
    titleCount: 0,
    lastTitle: null,
    finalsAppearances: 0,
    lastYearInFinals: null,
    sfExitCount: 0,
    lastYearInSemis: null,
    neverPastQF: false,
    neverMadeFinals: true,
    seasons: [{ year: 2021, place: 5 }],
    ...over,
  });

  it('leads with a Cup when there is one', () => {
    assert.match(previewHistoryFact('Alice', hist({ titleCount: 1, lastTitle: 2022 })), /won it in 2022/);
    assert.match(previewHistoryFact('Alice', hist({ titleCount: 3, lastTitle: 2024 })), /3 Cups, most recently 2024/);
  });

  it('never tells a 3rd-place-game manager he is reaching his first Final', () => {
    const h = hist({ neverMadeFinals: true, sfExitCount: 2, lastYearInSemis: 2023 });
    assert.match(previewHistoryFact('Alice', h, 'Championship'), /never reached a Final/);
    assert.match(previewHistoryFact('Alice', h, '3rd Place'), /lost 2 semifinals/);
  });

  it('says so plainly when there is no finished season on record', () => {
    assert.match(previewHistoryFact('Alice', null), /no finished WMMC season on record/);
    assert.match(previewHistoryFact('Alice', hist({ seasonsPlayed: 0 })), /no finished WMMC season on record/);
  });

  it('falls back to the BEST finish, not the most recent one', () => {
    const h = hist({
      neverMadeFinals: false,
      finalsAppearances: 0,
      seasons: [
        { year: 2021, place: 3 },
        { year: 2024, place: 8 },
      ],
    });
    assert.match(previewHistoryFact('Alice', h), /best finish is 3rd, in 2021/);
  });

  it('pluralizes and ordinalizes correctly', () => {
    const reachedFinal = (n) => hist({ neverMadeFinals: false, finalsAppearances: n, lastYearInFinals: 2020 });
    assert.match(previewHistoryFact('Alice', reachedFinal(1)), /1 Final and no Cup/);
    assert.match(previewHistoryFact('Alice', reachedFinal(2)), /2 Finals and no Cup/);
    assert.match(
      previewHistoryFact('Alice', hist({ seasonsPlayed: 1, neverPastQF: true, neverMadeFinals: false })),
      /across 1 season\b/
    );
  });
});

describe('previewEdge', () => {
  it('picks the leader and labels the pick as form, not a forecast', () => {
    const out = previewEdge(team(), team({ name: 'Bob', playoffPoints: 1000 }));
    assert.match(out, /Form likes Alice/);
    assert.match(out, /200 more points/);
    assert.match(out, /form, not a forecast/);
  });

  it('calls a dead heat a dead heat instead of picking on a rounding error', () => {
    const out = previewEdge(team(), team({ name: 'Bob', playoffPoints: 1200.4 }));
    assert.match(out, /Dead level/);
    assert.doesNotMatch(out, /Form likes/);
  });

  it('scales the verdict to the size of the totals, not the raw gap', () => {
    // 20 points apart on 1,200 is nothing; 20 apart on 100 is a rout.
    assert.match(previewEdge(team(), team({ name: 'Bob', playoffPoints: 1180 })), /close enough to nothing/);
    assert.match(
      previewEdge(team({ playoffPoints: 100 }), team({ name: 'Bob', playoffPoints: 80 })),
      /has not been close/
    );
  });

  it('declines to pick when neither side has scored in the bracket', () => {
    assert.equal(previewEdge(team({ playoffPoints: 0 }), team({ name: 'Bob', playoffPoints: 0 })), '');
  });
});

describe('buildMatchupPreview', () => {
  it('renders seeds, splits, top performers, history and the edge', () => {
    const out = buildMatchupPreview({
      label: 'Championship',
      teams: [team(), team({ name: 'Bob', seed: 4, playoffPoints: 1000 })],
    });
    assert.match(out, /\*Championship\* — \(1\) Alice vs \(4\) Bob/);
    assert.match(out, /1,200 pts in the bracket \(QF 610\.3 · SF 589\.8\)/);
    assert.match(out, /carried by Aaron Judge 188\.4, Tarik Skubal 141/);
    assert.match(out, /Form likes Alice/);
  });

  it('omits the parts it has no data for rather than printing empties', () => {
    const out = buildMatchupPreview({
      label: '3rd Place',
      teams: [
        { name: 'Carl', playoffPoints: 0, roundPoints: [], top: [] },
        { name: 'Dave', playoffPoints: 0, roundPoints: [], top: [] },
      ],
    });
    assert.match(out, /\*3rd Place\* — Carl vs Dave/);
    assert.doesNotMatch(out, /carried by/);
    assert.doesNotMatch(out, /Form likes/);
    assert.doesNotMatch(out, /undefined/);
  });

  it('refuses to render a half-known matchup', () => {
    assert.equal(buildMatchupPreview({ label: 'Championship', teams: [team()] }), '');
    assert.equal(buildMatchupPreview({ label: 'Championship', teams: [team(), { name: '' }] }), '');
    assert.equal(buildMatchupPreview(null), '');
  });

  it('caps the carried-by list at three players', () => {
    const out = buildMatchupPreview({
      label: 'Championship',
      teams: [
        team({
          top: [
            { name: 'A', points: 4 },
            { name: 'B', points: 3 },
            { name: 'C', points: 2 },
            { name: 'D', points: 1 },
          ],
        }),
        team({ name: 'Bob' }),
      ],
    });
    assert.doesNotMatch(out, /\bD 1\b/);
  });
});

describe('buildRoundPreviewBlock', () => {
  it('stacks a heading over one block per matchup', () => {
    const out = buildRoundPreviewBlock({
      heading: 'UP NEXT',
      matchups: [
        { label: 'Championship', emoji: 'X', teams: [team(), team({ name: 'Bob' })] },
        { label: '3rd Place', emoji: 'Y', teams: [team({ name: 'Carl' }), team({ name: 'Dave' })] },
      ],
    });
    assert.match(out, /^UP NEXT\n\nX \*Championship\*/);
    assert.match(out, /Y \*3rd Place\*/);
  });

  it('returns empty when nothing is previewable, so callers can append unconditionally', () => {
    assert.equal(buildRoundPreviewBlock({ matchups: [] }), '');
    assert.equal(buildRoundPreviewBlock({ matchups: [{ label: 'Championship', teams: [team()] }] }), '');
    assert.equal(buildRoundPreviewBlock(), '');
  });
});
