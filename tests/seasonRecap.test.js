import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtRecapScore,
  recapOrdinal,
  buildPodiumBlock,
  buildFinalStandingsBlock,
  buildSuperlativesBlock,
  buildHistoryBlock,
  fallbackSeasonRecap,
  recapHistoryFact,
  buildSeasonRecapText,
} from '../js/seasonRecap.js';

const facts = (over = {}) => ({
  year: '2026',
  champion: 'Alice Adams',
  runnerUp: 'Bob Barker',
  third: 'Carla Cruz',
  fourth: 'Dave Dunn',
  championship: {
    winner: 'Alice Adams',
    winnerScore: 1204.55,
    loser: 'Bob Barker',
    loserScore: 1180.2,
    margin: 24.35,
  },
  thirdPlaceGame: {
    winner: 'Carla Cruz',
    winnerScore: 1100,
    loser: 'Dave Dunn',
    loserScore: 990.5,
    margin: 109.5,
  },
  standings: [
    { place: 1, manager: 'Alice Adams', exit: 'Champion', seasonPoints: 8200.4 },
    { place: 2, manager: 'Bob Barker', exit: 'Lost the Championship', seasonPoints: 8100 },
    { place: 3, manager: 'Carla Cruz', exit: 'Won the 3rd-place game', seasonPoints: 7900.25 },
    { place: 4, manager: 'Dave Dunn', exit: 'Lost the 3rd-place game', seasonPoints: 7800 },
    { place: 5, manager: 'Erin Ellis', exit: 'Out in the Quarterfinals', seasonPoints: 5100 },
  ],
  superlatives: {
    seasonPoints: { manager: 'Erin Ellis', points: 8300.1 },
    poolPlayLeader: { manager: 'Alice Adams', points: 5000 },
    bestWeek: { manager: 'Bob Barker', label: 'PP2 Week 3', points: 640.25 },
    topBatter: { name: 'Aaron Judge', manager: 'Alice Adams', points: 890.5 },
    topPitcher: { name: 'Tarik Skubal', manager: 'Carla Cruz', points: 700 },
    biggestBlowout: { label: 'QF', winner: 'Alice Adams', loser: 'Frank Frey', margin: 410.75 },
    closestGame: { label: 'Championship', winner: 'Alice Adams', loser: 'Bob Barker', margin: 24.35 },
    mostSwaps: { manager: 'Dave Dunn', count: 9 },
  },
  historyLines: ['Alice Adams has now won two Cups.'],
  ...over,
});

describe('fmtRecapScore', () => {
  it('formats one decimal with separators and drops a trailing .0', () => {
    assert.equal(fmtRecapScore(1204.55), '1,204.6');
    assert.equal(fmtRecapScore(1200), '1,200');
    assert.equal(fmtRecapScore(0), '0');
  });

  it('never renders a non-number as NaN', () => {
    assert.equal(fmtRecapScore(undefined), '0');
    assert.equal(fmtRecapScore('nope'), '0');
  });
});

describe('recapOrdinal', () => {
  it('handles the teens and the ones digit', () => {
    assert.equal(recapOrdinal(1), '1st');
    assert.equal(recapOrdinal(2), '2nd');
    assert.equal(recapOrdinal(3), '3rd');
    assert.equal(recapOrdinal(4), '4th');
    assert.equal(recapOrdinal(11), '11th');
    assert.equal(recapOrdinal(12), '12th');
    assert.equal(recapOrdinal(13), '13th');
    assert.equal(recapOrdinal(21), '21st');
  });
});

describe('buildPodiumBlock', () => {
  it('names all four Finals-week managers and the two games that sorted them', () => {
    const out = buildPodiumBlock(facts());
    assert.match(out, /goes to Alice Adams/);
    assert.match(out, /\*1st — Alice Adams\* — won the Championship 1,204.6–1,180.2 \(by 24.4\)/);
    assert.match(out, /\*2nd — Bob Barker\* — lost the Championship 1,180.2–1,204.6 \(by 24.4\)/);
    assert.match(out, /\*3rd — Carla Cruz\* — won the 3rd-place game 1,100–990.5 \(by 109.5\)/);
    assert.match(out, /\*4th — Dave Dunn\* — lost the 3rd-place game 990.5–1,100 \(by 109.5\)/);
  });

  it('still names the podium when the game scores are missing', () => {
    const out = buildPodiumBlock(facts({ championship: null, thirdPlaceGame: null }));
    assert.match(out, /\*1st — Alice Adams\*$/m);
    assert.doesNotMatch(out, /won the Championship/);
  });

  it('returns empty without a champion, so a caller can fail loudly', () => {
    assert.equal(buildPodiumBlock(facts({ champion: null })), '');
    assert.equal(buildPodiumBlock(null), '');
  });
});

describe('buildFinalStandingsBlock', () => {
  it('renders every manager in the order it was handed', () => {
    const out = buildFinalStandingsBlock(facts().standings);
    const order = out
      .split('\n')
      .slice(1)
      .map((l) => l.split('*')[1]);
    assert.deepEqual(order, ['Alice Adams', 'Bob Barker', 'Carla Cruz', 'Dave Dunn', 'Erin Ellis']);
    assert.match(out, /5th\. \*Erin Ellis\* — Out in the Quarterfinals · 5,100 pts/);
  });

  it('omits the points when a manager has none', () => {
    const out = buildFinalStandingsBlock([{ place: 1, manager: 'Alice Adams', exit: 'Champion' }]);
    assert.equal(out.split('\n')[1], '1st. *Alice Adams* — Champion');
  });

  it('returns empty for no standings', () => {
    assert.equal(buildFinalStandingsBlock([]), '');
    assert.equal(buildFinalStandingsBlock(null), '');
  });
});

describe('buildSuperlativesBlock', () => {
  it('renders each superlative that is present', () => {
    const out = buildSuperlativesBlock(facts().superlatives);
    assert.match(out, /Most points all season:\* Erin Ellis — 8,300.1/);
    assert.match(out, /Best single week:\* Bob Barker — 640.3 in PP2 Week 3/);
    assert.match(out, /Top bat:\* Aaron Judge — 890.5 for Alice Adams/);
    assert.match(out, /Busiest waiver wire:\* Dave Dunn — 9 approved swaps/);
  });

  it('singularizes a one-swap season', () => {
    const out = buildSuperlativesBlock({ mostSwaps: { manager: 'Dave Dunn', count: 1 } });
    assert.match(out, /1 approved swap$/m);
  });

  it('drops silently when nothing survived', () => {
    assert.equal(buildSuperlativesBlock({}), '');
    assert.equal(buildSuperlativesBlock(null), '');
  });
});

describe('buildHistoryBlock', () => {
  it('labels each line so a manager name never opens an italic run', () => {
    const out = buildHistoryBlock(['Alice Adams has now won two Cups.']);
    assert.match(out, /^> _History:_ Alice Adams has now won two Cups\.$/m);
  });

  it('drops blank lines and returns empty for none', () => {
    assert.equal(buildHistoryBlock(['   ', '']), '');
    assert.equal(buildHistoryBlock(null), '');
  });
});

describe('fallbackSeasonRecap', () => {
  it('is stable for the same season and names the champion', () => {
    const a = fallbackSeasonRecap(facts());
    const b = fallbackSeasonRecap(facts());
    assert.equal(a, b);
    assert.match(a, /Alice Adams/);
  });

  it('quotes only supplied numbers', () => {
    const out = fallbackSeasonRecap(facts());
    for (const n of out.match(/\d[\d,]*\.?\d*/g) || []) {
      assert.ok(['2026', '24.4'].includes(n), `unexpected figure ${n} in the fallback wrap`);
    }
  });

  it('survives a season with almost nothing derived', () => {
    const out = fallbackSeasonRecap({ year: '2026', champion: 'Alice Adams' });
    assert.ok(out.length > 0);
    assert.match(out, /Alice Adams/);
  });
});

describe('buildSeasonRecapText', () => {
  it('puts the wrap above the receipts', () => {
    const out = buildSeasonRecapText(facts(), 'What a year.');
    const wrapAt = out.indexOf('What a year.');
    assert.ok(wrapAt > out.indexOf('goes to Alice Adams'));
    assert.ok(wrapAt < out.indexOf('Final standings'));
    assert.ok(out.indexOf('Final standings') < out.indexOf('Season superlatives'));
    assert.match(out, /wmmc\.live/);
  });

  it('omits the wrap section entirely when there is no wrap', () => {
    const out = buildSeasonRecapText(facts(), '   ');
    assert.doesNotMatch(out, /season, in review/);
    assert.match(out, /Final standings/);
  });

  it('returns empty without a podium rather than posting a shell', () => {
    assert.equal(buildSeasonRecapText(facts({ champion: null }), 'What a year.'), '');
  });
});

describe('recapHistoryFact', () => {
  const hist = (over = {}) => ({
    seasonsPlayed: 5,
    titleCount: 0,
    lastTitle: null,
    finalsAppearances: 0,
    neverMadeFinals: true,
    seasons: [
      { year: 2022, place: 5 },
      { year: 2024, place: 3 },
    ],
    ...over,
  });

  it('handles a first-year manager with no record at all', () => {
    assert.match(recapHistoryFact('Alice Adams', null, 1), /no finished WMMC season on record/);
    assert.match(recapHistoryFact('Alice Adams', { seasonsPlayed: 0 }, 1), /no finished WMMC season on record/);
  });

  it("calls a first champion's Final losses out by name", () => {
    const out = recapHistoryFact('Alice Adams', hist({ finalsAppearances: 2, neverMadeFinals: false }), 1);
    assert.match(out, /had lost 2 Finals across 5 seasons and never won one/);
  });

  it('counts a repeat champion by prior Cups only, never including this one', () => {
    const out = recapHistoryFact('Alice Adams', hist({ titleCount: 2, finalsAppearances: 3, lastTitle: 2024 }), 1);
    assert.match(out, /already won 2 Cups, the last in 2024/);
  });

  it("separates a runner-up's prior Finals from their prior Cups", () => {
    assert.match(
      recapHistoryFact('Bob Barker', hist({ finalsAppearances: 3, titleCount: 1, lastTitle: 2023 }), 2),
      /has 1 Cup at home, the last in 2023, and did not add one/
    );
    assert.match(
      recapHistoryFact('Bob Barker', hist({ finalsAppearances: 2, neverMadeFinals: false }), 2),
      /had already lost 2 Finals before this one/
    );
    assert.match(recapHistoryFact('Bob Barker', hist(), 2), /had never reached a Final in 5 seasons/);
  });

  it('falls back to a best finish for 3rd and 4th', () => {
    const out = recapHistoryFact('Carla Cruz', hist({ neverMadeFinals: false }), 3);
    assert.match(out, /best finish before this year was 3rd, in 2024/);
  });

  it('never claims a Cup a manager does not have', () => {
    for (const place of [1, 2, 3, 4]) {
      assert.doesNotMatch(recapHistoryFact('Alice Adams', hist(), place), /won 1 Cup|won 2 Cups/);
    }
  });
});
