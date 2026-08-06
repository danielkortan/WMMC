import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBracket } from '../js/bracket.js';

const SEEDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

// Higher seed always scores more, so the favourite wins every game.
const chalk = (manager) => 100 - Number(manager.slice(1));

const labels = (bracket, round) =>
  bracket.rounds
    .find((r) => r.round === round)
    .matchups.map((m) => `${m.label}: ${m.a.name}(${m.a.seed}) v ${m.b.name}(${m.b.seed})`);

describe('resolveBracket structure', () => {
  it('returns null without a full eight-manager field', () => {
    assert.equal(
      resolveBracket(['A', 'B'], () => 1),
      null
    );
    assert.equal(
      resolveBracket(null, () => 1),
      null
    );
  });

  it('pairs the quarterfinals 1v8, 4v5, 3v6, 2v7', () => {
    const b = resolveBracket(SEEDS, chalk);
    assert.deepEqual(labels(b, 'QF'), [
      'QF1: S1(1) v S8(8)',
      'QF4: S4(4) v S5(5)',
      'QF3: S3(3) v S6(6)',
      'QF2: S2(2) v S7(7)',
    ]);
  });

  it('pairs the semifinals from quarterfinal winners in bracket order', () => {
    const b = resolveBracket(SEEDS, chalk);
    assert.deepEqual(labels(b, 'SF'), ['SF1: S1(1) v S4(4)', 'SF2: S3(3) v S2(2)']);
  });

  it('sends semifinal winners to the championship and losers to the third-place game', () => {
    const b = resolveBracket(SEEDS, chalk);
    const finals = b.rounds.find((r) => r.round === 'Finals').matchups;
    assert.equal(finals[0].label, 'Championship');
    assert.deepEqual([finals[0].a.name, finals[0].b.name], ['S1', 'S2']);
    assert.equal(finals[1].label, '3rd Place');
    assert.deepEqual([finals[1].a.name, finals[1].b.name], ['S4', 'S3']);
    assert.equal(b.champion, 'S1');
    // Third place is SF1's loser (S4) against SF2's loser (S3); under `chalk` the better seed
    // scores more, so S3 takes it.
    assert.equal(b.thirdPlace, 'S3');
    assert.equal(b.complete, true);
  });
});

describe('resolveBracket results', () => {
  it('lets an upset carry through the bracket', () => {
    // The 8 seed outscores everyone; everything else runs to form.
    const score = (m) => (m === 'S8' ? 1000 : chalk(m));
    const b = resolveBracket(SEEDS, score);
    assert.equal(b.champion, 'S8');
    assert.deepEqual(labels(b, 'SF'), ['SF1: S8(8) v S4(4)', 'SF2: S3(3) v S2(2)']);
  });

  it('breaks a tied matchup in favour of the better seed', () => {
    const b = resolveBracket(SEEDS, () => 50);
    const qf1 = b.rounds[0].matchups[0];
    assert.equal(qf1.winner.name, 'S1', 'the 1 seed beats the 8 on a tie');
    assert.equal(qf1.loser.name, 'S8');
    assert.equal(b.champion, 'S1');
  });

  it('records the loser of every decided matchup', () => {
    const b = resolveBracket(SEEDS, chalk);
    for (const round of b.rounds) {
      for (const m of round.matchups) {
        assert.ok(m.winner && m.loser, `${m.label} should be decided`);
        assert.notEqual(m.winner.name, m.loser.name);
      }
    }
  });

  it('rounds scores to cents', () => {
    const b = resolveBracket(SEEDS, () => 1 / 3);
    assert.equal(b.rounds[0].matchups[0].a.score, 0.33);
  });
});

describe('resolveBracket with missing rosters', () => {
  // The honest case: a manager the scenario promoted into the field who never played that round.
  const noRosterFor = (who, round) => (m, r) => (m === who && r === round ? null : chalk(m));

  it('leaves a matchup undecided when one side has no roster', () => {
    const b = resolveBracket(SEEDS, noRosterFor('S8', 'QF'));
    const qf1 = b.rounds[0].matchups[0];
    assert.equal(qf1.b.score, null);
    assert.equal(qf1.undecided, true);
    assert.equal(qf1.winner, null);
  });

  it('does not invent a semifinal when a quarterfinal is unresolved', () => {
    const b = resolveBracket(SEEDS, noRosterFor('S8', 'QF'));
    assert.equal(
      b.rounds.some((r) => r.round === 'SF'),
      false,
      'the semifinal must not appear while a feeding matchup is open'
    );
    assert.equal(b.champion, null);
    assert.equal(b.complete, false);
  });

  it('reports exactly who is missing a roster and for which round', () => {
    const b = resolveBracket(SEEDS, noRosterFor('S8', 'QF'));
    assert.deepEqual(b.missing, [{ manager: 'S8', round: 'QF' }]);
  });

  it('stops at the semifinal when a promoted manager has no semifinal roster', () => {
    const b = resolveBracket(SEEDS, noRosterFor('S1', 'SF'));
    assert.equal(b.rounds.length, 2, 'quarterfinals and semifinals only');
    assert.equal(b.rounds[1].matchups[0].undecided, true);
    assert.equal(b.champion, null);
    assert.deepEqual(b.missing, [{ manager: 'S1', round: 'SF' }]);
  });

  it('still resolves the half of the bracket that has rosters', () => {
    const b = resolveBracket(SEEDS, noRosterFor('S8', 'QF'));
    const decided = b.rounds[0].matchups.filter((m) => !m.undecided).map((m) => m.winner.name);
    assert.deepEqual(decided, ['S4', 'S3', 'S2'], 'the other three quarterfinals still resolve');
  });

  it('treats a zero score as a real result, not a missing roster', () => {
    const b = resolveBracket(SEEDS, (m) => (m === 'S8' ? 0 : chalk(m)));
    const qf1 = b.rounds[0].matchups[0];
    assert.equal(qf1.b.score, 0);
    assert.equal(qf1.undecided, false);
    assert.equal(qf1.winner.name, 'S1');
    assert.deepEqual(b.missing, []);
  });
});
