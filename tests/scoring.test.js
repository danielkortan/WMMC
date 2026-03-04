import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateBattingScore, calculatePitchingScore, convertIP, computeManagerScores, countUploadedWeeks } from '../js/scoring.js';

describe('calculateBattingScore', () => {
  it('returns 0 for empty stats', () => {
    assert.equal(calculateBattingScore({}), 0);
  });

  it('scores singles correctly (3 pts each)', () => {
    assert.equal(calculateBattingScore({ '1b': 5 }), 15);
  });

  it('scores doubles correctly (5 pts each)', () => {
    assert.equal(calculateBattingScore({ '2b': 3 }), 15);
  });

  it('scores triples correctly (8 pts each)', () => {
    assert.equal(calculateBattingScore({ '3b': 2 }), 16);
  });

  it('scores home runs correctly (10 pts each)', () => {
    assert.equal(calculateBattingScore({ hr: 4 }), 40);
  });

  it('scores runs correctly (2 pts each)', () => {
    assert.equal(calculateBattingScore({ r: 7 }), 14);
  });

  it('scores RBIs correctly (2 pts each)', () => {
    assert.equal(calculateBattingScore({ rbi: 6 }), 12);
  });

  it('scores stolen bases correctly (5 pts each)', () => {
    assert.equal(calculateBattingScore({ sb: 3 }), 15);
  });

  it('scores walks correctly (2 pts each)', () => {
    assert.equal(calculateBattingScore({ bb: 4 }), 8);
  });

  it('calculates combined batting score correctly', () => {
    const stats = { '1b': 10, '2b': 5, '3b': 1, hr: 3, r: 8, rbi: 7, sb: 2, bb: 6 };
    // 10*3 + 5*5 + 1*8 + 3*10 + 8*2 + 7*2 + 2*5 + 6*2 = 30+25+8+30+16+14+10+12 = 145
    assert.equal(calculateBattingScore(stats), 145);
  });

  it('handles missing fields gracefully', () => {
    const stats = { hr: 2, r: 5 };
    // 2*10 + 5*2 = 30
    assert.equal(calculateBattingScore(stats), 30);
  });
});

describe('calculatePitchingScore', () => {
  it('returns 0 for empty stats', () => {
    assert.equal(calculatePitchingScore({}), 0);
  });

  it('scores wins correctly (4 pts each)', () => {
    assert.equal(calculatePitchingScore({ w: 2 }), 8);
  });

  it('scores quality starts correctly (4 pts each)', () => {
    assert.equal(calculatePitchingScore({ qs: 3 }), 12);
  });

  it('scores innings pitched correctly (2.25 pts each)', () => {
    assert.equal(calculatePitchingScore({ ip: 6 }), 13.5);
  });

  it('scores strikeouts correctly (2 pts each)', () => {
    assert.equal(calculatePitchingScore({ k: 8 }), 16);
  });

  it('applies negative scoring for hits (-0.6 pts each)', () => {
    assert.equal(calculatePitchingScore({ h: 5 }), -3);
  });

  it('applies negative scoring for earned runs (-2 pts each)', () => {
    assert.equal(calculatePitchingScore({ er: 3 }), -6);
  });

  it('applies negative scoring for walks (-0.6 pts each)', () => {
    assert.equal(calculatePitchingScore({ bb: 2 }), -1.2);
  });

  it('scores no-hitters correctly (5 pts each)', () => {
    assert.equal(calculatePitchingScore({ nh: 1 }), 5);
  });

  it('calculates combined pitching score correctly', () => {
    const stats = { w: 1, qs: 1, ip: 7, h: 4, er: 2, bb: 1, k: 9 };
    // 1*4 + 1*4 + 7*2.25 + 4*(-0.6) + 2*(-2) + 1*(-0.6) + 9*2
    // = 4 + 4 + 15.75 + (-2.4) + (-4) + (-0.6) + 18 = 34.75
    assert.equal(calculatePitchingScore(stats), 34.75);
  });

  it('handles a bad outing with net negative score', () => {
    const stats = { ip: 2, h: 8, er: 6, bb: 3, k: 1 };
    // 2*2.25 + 8*(-0.6) + 6*(-2) + 3*(-0.6) + 1*2
    // = 4.5 + (-4.8) + (-12) + (-1.8) + 2 = -12.1
    assert.equal(calculatePitchingScore(stats), -12.1);
  });
});

describe('convertIP', () => {
  it('converts .1 to .33', () => {
    assert.equal(convertIP(6.1), 6.33);
  });

  it('converts .2 to .66', () => {
    assert.equal(convertIP(5.2), 5.66);
  });

  it('leaves whole numbers unchanged', () => {
    assert.equal(convertIP(7), 7);
  });

  it('leaves standard decimals unchanged', () => {
    assert.equal(convertIP(6.5), 6.5);
  });

  it('handles zero', () => {
    assert.equal(convertIP(0), 0);
  });
});

describe('computeManagerScores', () => {
  it('returns empty array for no data', () => {
    const result = computeManagerScores({ weekly_batting: [], weekly_pitching: [] });
    assert.deepEqual(result, []);
  });

  it('aggregates batting and pitching scores per manager', () => {
    const seasonData = {
      weekly_batting: [
        { manager: 'Alice', weekly_score: 50 },
        { manager: 'Alice', weekly_score: 60 },
        { manager: 'Bob', weekly_score: 45 },
      ],
      weekly_pitching: [
        { manager: 'Alice', weekly_score: 30 },
        { manager: 'Bob', weekly_score: 40 },
      ]
    };
    const result = computeManagerScores(seasonData);
    const alice = result.find(m => m.manager === 'Alice');
    const bob = result.find(m => m.manager === 'Bob');

    assert.equal(alice.batting, 110);
    assert.equal(alice.pitching, 30);
    assert.equal(alice.total, 140);
    assert.equal(bob.batting, 45);
    assert.equal(bob.pitching, 40);
    assert.equal(bob.total, 85);
  });

  it('skips entries with null manager', () => {
    const seasonData = {
      weekly_batting: [
        { manager: null, weekly_score: 100 },
        { manager: 'Alice', weekly_score: 50 },
      ],
      weekly_pitching: []
    };
    const result = computeManagerScores(seasonData);
    assert.equal(result.length, 1);
    assert.equal(result[0].manager, 'Alice');
  });
});

describe('countUploadedWeeks', () => {
  it('returns 0 for no batting data', () => {
    assert.equal(countUploadedWeeks({ weekly_batting: [] }), 0);
  });

  it('counts unique round|week combinations', () => {
    const seasonData = {
      weekly_batting: [
        { round: 'PP1', week: 'Week 1' },
        { round: 'PP1', week: 'Week 1' },
        { round: 'PP1', week: 'Week 2' },
        { round: 'PP2', week: 'Week 1' },
      ]
    };
    assert.equal(countUploadedWeeks(seasonData), 3);
  });
});
