import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePlayoffStatuses, playoffStatusLabel, statusKeyForPosition } from '../js/playoffStatus.js';

// 12 managers; the 8-team field in seed order; the rest miss the playoffs.
const managers = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'Out1', 'Out2', 'Out3', 'Out4'];
const qualifiers = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
const ppTotals = { S1: 900, S2: 880, S3: 860, S4: 840, S5: 820, S6: 800, S7: 780, S8: 760, Out1: 700, Out2: 650, Out3: 600, Out4: 550 }; // prettier-ignore

// Bracket: 1v8, 4v5, 3v6, 2v7 → S1/S4/S3/S2 advance; SF S1vS4, S3vS2 → S1/S2; Finals S1 over S2,
// 3rd-place game S4 over S3.
const sfParticipants = ['S1', 'S4', 'S3', 'S2'];
const finalsParticipants = ['S1', 'S2'];
const roundTotals = {
  QF: { S1: 300, S2: 290, S3: 280, S4: 270, S5: 260, S6: 250, S7: 240, S8: 230 },
  SF: { S1: 300, S2: 290, S3: 280, S4: 270 },
  Finals: { S1: 310, S2: 300, S3: 250, S4: 260 },
};

const base = { managers, qualifiers, ppTotals, roundTotals, sfParticipants, finalsParticipants };
const statusOf = (res, name) => (res.entries.find((e) => e.name === name) || {}).status;
const liveNames = (res) => res.entries.filter((e) => e.live).map((e) => e.name);

describe('statusKeyForPosition', () => {
  it('maps final positions onto the finished-season vocabulary', () => {
    assert.equal(statusKeyForPosition(1), 'finals');
    assert.equal(statusKeyForPosition(2), 'finals');
    assert.equal(statusKeyForPosition(3), 'consolation');
    assert.equal(statusKeyForPosition(4), 'consolation');
    assert.equal(statusKeyForPosition(5), 'quarterfinals');
    assert.equal(statusKeyForPosition(8), 'quarterfinals');
    assert.equal(statusKeyForPosition(9), 'dnq');
    assert.equal(statusKeyForPosition(12), 'dnq');
  });
  it('labels every status key', () => {
    assert.equal(playoffStatusLabel('dnq'), 'Did Not Qualify');
    assert.equal(playoffStatusLabel('semifinals'), 'Semifinals');
    assert.equal(playoffStatusLabel('consolation'), 'Consolation');
  });
});

describe('computePlayoffStatuses — before the playoffs', () => {
  it('leaves everyone in pool play until PP is finalized', () => {
    const res = computePlayoffStatuses({ ...base, finalized: [] });
    assert.equal(res.currentRound, 'PP');
    assert.equal(res.complete, false);
    assert.equal(res.entries.length, 12);
    assert.ok(res.entries.every((e) => e.live && e.status === 'Pool Play' && e.position === null));
    assert.deepEqual(res.standings, {});
  });

  it('does not invent a field when seeding is missing', () => {
    const res = computePlayoffStatuses({ ...base, qualifiers: [], finalized: ['PP'] });
    assert.ok(res.entries.every((e) => e.statusKey === 'pool'));
  });
});

describe('computePlayoffStatuses — pool play finalized', () => {
  const res = computePlayoffStatuses({ ...base, finalized: ['PP'] });

  it('gives all 8 qualifiers a live Quarterfinals status', () => {
    assert.equal(res.currentRound, 'QF');
    assert.deepEqual(liveNames(res), qualifiers);
    assert.ok(res.entries.filter((e) => e.live).every((e) => e.status === 'Quarterfinals'));
    assert.ok(res.entries.filter((e) => e.live).every((e) => e.position === null));
  });

  it('settles the non-qualifiers at 9th-12th by pool-play total', () => {
    assert.deepEqual(res.standings, { Out1: 9, Out2: 10, Out3: 11, Out4: 12 });
    assert.equal(statusOf(res, 'Out1'), 'Did Not Qualify');
    assert.ok(res.entries.filter((e) => !e.live).every((e) => e.statusKey === 'dnq'));
  });

  it('orders live managers by seed and puts them above the eliminated', () => {
    assert.deepEqual(
      res.entries.map((e) => e.name),
      [...qualifiers, 'Out1', 'Out2', 'Out3', 'Out4']
    );
  });
});

describe('computePlayoffStatuses — QF finalized', () => {
  const res = computePlayoffStatuses({ ...base, finalized: ['PP', 'QF'] });

  it('flips the four winners to a live Semifinals', () => {
    assert.equal(res.currentRound, 'SF');
    assert.deepEqual(liveNames(res).sort(), ['S1', 'S2', 'S3', 'S4']);
    assert.ok(res.entries.filter((e) => e.live).every((e) => e.status === 'Semifinals'));
  });

  it('leaves the four losers at Quarterfinals, ranked 5th-8th by QF score', () => {
    assert.equal(res.standings.S5, 5);
    assert.equal(res.standings.S6, 6);
    assert.equal(res.standings.S7, 7);
    assert.equal(res.standings.S8, 8);
    assert.equal(statusOf(res, 'S5'), 'Quarterfinals');
  });

  it('keeps the non-qualifiers where pool play left them', () => {
    assert.equal(res.standings.Out1, 9);
    assert.equal(res.standings.Out4, 12);
  });

  it('breaks a QF-score tie among the losers by seed', () => {
    const tied = { ...roundTotals, QF: { ...roundTotals.QF, S5: 250, S6: 250 } };
    const r = computePlayoffStatuses({ ...base, roundTotals: tied, finalized: ['PP', 'QF'] });
    assert.equal(r.standings.S5, 5);
    assert.equal(r.standings.S6, 6);
  });
});

describe('computePlayoffStatuses — SF finalized', () => {
  const res = computePlayoffStatuses({ ...base, finalized: ['PP', 'QF', 'SF'] });

  it('puts the finalists on a live Finals and the SF losers on a live Consolation', () => {
    assert.equal(res.currentRound, 'Finals');
    assert.equal(statusOf(res, 'S1'), 'Finals');
    assert.equal(statusOf(res, 'S2'), 'Finals');
    assert.equal(statusOf(res, 'S3'), 'Consolation');
    assert.equal(statusOf(res, 'S4'), 'Consolation');
    assert.deepEqual(liveNames(res).sort(), ['S1', 'S2', 'S3', 'S4']);
  });

  it('still has no top-4 positions assigned', () => {
    assert.equal(res.complete, false);
    assert.deepEqual(Object.keys(res.standings).sort(), ['Out1', 'Out2', 'Out3', 'Out4', 'S5', 'S6', 'S7', 'S8']);
  });
});

describe('computePlayoffStatuses — season complete', () => {
  const res = computePlayoffStatuses({ ...base, finalized: ['PP', 'QF', 'SF', 'Finals'] });

  it('resolves the full 1-12 standings with nobody live', () => {
    assert.equal(res.complete, true);
    assert.equal(res.currentRound, null);
    assert.deepEqual(liveNames(res), []);
    assert.deepEqual(res.standings, {
      S1: 1,
      S2: 2,
      S4: 3,
      S3: 4,
      S5: 5,
      S6: 6,
      S7: 7,
      S8: 8,
      Out1: 9,
      Out2: 10,
      Out3: 11,
      Out4: 12,
    });
  });

  it('reports the podium', () => {
    assert.equal(res.champion, 'S1');
    assert.equal(res.runnerUp, 'S2');
    assert.equal(res.third, 'S4');
  });

  it('decides the 3rd-place game on Finals-round scores, not seed order', () => {
    // S4 (worse seed) outscored S3 in the Finals round, so S4 takes 3rd.
    assert.equal(statusOf(res, 'S4'), 'Consolation');
    assert.equal(res.standings.S4, 3);
    assert.equal(res.standings.S3, 4);
  });

  it('gives a tied championship to the better seed', () => {
    const tied = { ...roundTotals, Finals: { ...roundTotals.Finals, S1: 300, S2: 300 } };
    const r = computePlayoffStatuses({ ...base, roundTotals: tied, finalized: ['PP', 'QF', 'SF', 'Finals'] });
    assert.equal(r.champion, 'S1');
  });

  it('sorts the entries by finishing position', () => {
    assert.deepEqual(
      res.entries.map((e) => e.name),
      ['S1', 'S2', 'S4', 'S3', 'S5', 'S6', 'S7', 'S8', 'Out1', 'Out2', 'Out3', 'Out4']
    );
  });
});

describe('computePlayoffStatuses — defensive', () => {
  it('keeps the field live when QF is flagged final but the winners are unresolved', () => {
    const res = computePlayoffStatuses({ ...base, sfParticipants: null, finalized: ['PP', 'QF'] });
    assert.deepEqual(liveNames(res), qualifiers);
    assert.ok(res.entries.filter((e) => e.live).every((e) => e.status === 'Quarterfinals'));
  });

  it('keeps the semifinalists live when SF is flagged final but the finalists are unresolved', () => {
    const res = computePlayoffStatuses({ ...base, finalsParticipants: [], finalized: ['PP', 'QF', 'SF'] });
    assert.deepEqual(liveNames(res).sort(), ['S1', 'S2', 'S3', 'S4']);
    assert.ok(res.entries.filter((e) => e.live).every((e) => e.status === 'Semifinals'));
  });

  it('ignores qualifiers who are not in the canonical manager list', () => {
    const res = computePlayoffStatuses({
      ...base,
      qualifiers: [...qualifiers, 'Ghost'],
      finalized: ['PP'],
    });
    assert.equal(res.entries.length, 12);
    assert.ok(!res.entries.some((e) => e.name === 'Ghost'));
  });

  it('handles an empty manager list', () => {
    const res = computePlayoffStatuses({});
    assert.deepEqual(res.entries, []);
    assert.equal(res.complete, false);
  });
});
