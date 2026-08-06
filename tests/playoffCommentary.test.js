import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtPts,
  fmtDelta,
  endSentence,
  seedFromDate,
  matchupMovement,
  buildPlayoffCommentary,
  commentaryFactSheet,
  commentaryMentionsUnknownScore,
  tidyCommentaryLine,
  hotTakesCacheKey,
  hotTakesCacheHit,
  SLACK_EMOJI,
  enforceVettedEmoji,
  catchUpPace,
  commentaryBudget,
} from '../js/playoffCommentary.js';

const SHORT = {
  'Daniel Kortan': 'Daniel',
  'Alex Thalacker': 'Alex',
  'Jamie Rogers': 'Jamie',
  'Ryan Sullivan': 'Ryan S.',
};

// A history object shaped like managerPlayoffHistory's return, with every gate off by
// default so a test can switch on exactly the one rule it is checking.
function history(manager, over = {}) {
  return {
    manager,
    seasons: [],
    seasonsPlayed: 8,
    titles: [],
    titleCount: 0,
    lastTitle: null,
    runnerUps: [],
    playoffAppearances: 8,
    dnqCount: 0,
    qfExitCount: 0,
    sfExitCount: 0,
    finalsAppearances: 1,
    lastStage: 'QF',
    lastPlace: 5,
    lastYear: 2025,
    currentStageStreak: 1,
    lastYearInFinals: 2025,
    lastYearInSemis: 2025,
    neverPastQF: false,
    neverMadeFinals: false,
    ...over,
  };
}

describe('fmtPts / fmtDelta', () => {
  it('drops a redundant .0 and keeps a real decimal', () => {
    assert.equal(fmtPts(153), '153');
    assert.equal(fmtPts(153.7), '153.7');
    assert.equal(fmtPts(1234.56), '1,234.6');
    assert.equal(fmtPts(0), '0');
  });

  it('always signs a delta, including zero', () => {
    assert.equal(fmtDelta(48.4), '+48.4');
    assert.equal(fmtDelta(-3.25), '-3.3');
    assert.equal(fmtDelta(0), '+0');
    assert.equal(fmtDelta(null), '+0');
  });
});

describe('endSentence', () => {
  it('does not double the period after an initialled name', () => {
    assert.equal(endSentence('Ryan S.'), 'Ryan S.');
    assert.equal(endSentence('Daniel'), 'Daniel.');
    assert.equal(endSentence(''), '.');
    assert.equal(endSentence(null), '.');
  });
});

describe('seedFromDate', () => {
  it('is deterministic for a given date and differs between dates', () => {
    assert.equal(seedFromDate('2026-08-05'), seedFromDate('2026-08-05'));
    assert.notEqual(seedFromDate('2026-08-05'), seedFromDate('2026-08-06'));
    assert.equal(seedFromDate(null), 0);
  });
});

describe('matchupMovement', () => {
  it('reconstructs the standing as of the previous morning by backing out the deltas', () => {
    // Daniel trailed 105.3-100 before yesterday, then outscored Alex 48.4-4.
    const m = matchupMovement({
      label: 'SF1',
      a: 'Daniel Kortan',
      b: 'Alex Thalacker',
      aTotal: 148.4,
      bTotal: 109.3,
      aDelta: 48.4,
      bDelta: 4,
    });
    assert.equal(m.leaderBefore, 'Alex Thalacker');
    assert.equal(m.leaderNow, 'Daniel Kortan');
    assert.equal(m.trailerNow, 'Alex Thalacker');
    assert.equal(m.flipped, true);
    assert.equal(m.brokeTie, false);
    assert.equal(Math.round(m.marginBefore * 10) / 10, 5.3);
    assert.equal(Math.round(m.margin * 10) / 10, 39.1);
    assert.equal(m.dayWinner, 'Daniel Kortan');
    assert.equal(Math.round(m.dayGap * 10) / 10, 44.4);
  });

  it('does not call a widening lead a flip', () => {
    const m = matchupMovement({ label: 'SF2', a: 'A', b: 'B', aTotal: 200, bTotal: 100, aDelta: 30, bDelta: 10 });
    assert.equal(m.flipped, false);
    assert.equal(m.leaderBefore, 'A');
    assert.equal(m.leaderNow, 'A');
    assert.equal(m.swing, 20); // margin went 80 -> 100
  });

  it('reports a negative swing when the day closed the gap without flipping it', () => {
    const m = matchupMovement({ label: 'SF2', a: 'A', b: 'B', aTotal: 200, bTotal: 190, aDelta: 5, bDelta: 45 });
    assert.equal(m.flipped, false);
    assert.equal(m.margin, 10);
    assert.equal(m.marginBefore, 50);
    assert.equal(m.swing, -40);
  });

  it('treats coming out of a dead tie as breaking a tie, not a lead change', () => {
    // 100 vs 100 the morning before, so there is no previous leader to change.
    const m = matchupMovement({ label: 'SF1', a: 'A', b: 'B', aTotal: 110, bTotal: 100, aDelta: 10, bDelta: 0 });
    assert.equal(m.leaderBefore, null);
    assert.equal(m.leaderNow, 'A');
    assert.equal(m.brokeTie, true);
    assert.equal(m.flipped, false);
  });

  it('reports no leader at all while the two are level', () => {
    const m = matchupMovement({ label: 'SF1', a: 'A', b: 'B', aTotal: 100, bTotal: 100, aDelta: 10, bDelta: 30 });
    assert.equal(m.leaderNow, null);
    assert.equal(m.trailerNow, null);
    assert.equal(m.leaderBefore, 'A'); // 90 vs 70 the morning before
    assert.equal(m.flipped, false);
    assert.equal(m.brokeTie, false);
  });
});

describe('buildPlayoffCommentary', () => {
  const base = {
    round: 'SF',
    roundLabel: 'Semifinals',
    year: 2026,
    daysLeft: 5,
    shortNames: SHORT,
    seed: seedFromDate('2026-08-05'),
  };

  it('says nothing outside the playoff rounds', () => {
    assert.deepEqual(buildPlayoffCommentary({ ...base, round: 'PP2', matchups: [{ a: 'A', b: 'B' }] }), []);
    assert.deepEqual(buildPlayoffCommentary({ ...base, round: null, matchups: [{ a: 'A', b: 'B' }] }), []);
  });

  it('says nothing when there are no usable matchups', () => {
    assert.deepEqual(buildPlayoffCommentary({ ...base, matchups: [] }), []);
    assert.deepEqual(buildPlayoffCommentary({ ...base, matchups: [{ a: 'A' }] }), []);
  });

  it('leads with a lead change and names both managers by their short names', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      matchups: [
        {
          label: 'SF1',
          a: 'Daniel Kortan',
          b: 'Alex Thalacker',
          aTotal: 148.4,
          bTotal: 109.3,
          aDelta: 48.4,
          bDelta: 4,
        },
      ],
      dailyTotals: { 'Daniel Kortan': 48.4, 'Alex Thalacker': 4 },
    });
    assert.ok(lines.length >= 1);
    assert.match(lines[0], /Lead change|flipped|New leader/);
    assert.match(lines[0], /Daniel/);
    assert.match(lines[0], /Alex/);
    assert.ok(!lines[0].includes('Kortan'), 'uses the short name, not the full one');
  });

  it('calls out a blowout with the days remaining in the round', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      daysLeft: 3,
      matchups: [
        { label: 'SF2', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 400, bTotal: 100, aDelta: 20, bDelta: 20 },
      ],
      dailyTotals: { 'Jamie Rogers': 20, 'Ryan Sullivan': 20 },
    });
    const blowout = lines.find((l) => l.includes('300'));
    assert.ok(blowout, `expected a 300-pt blowout line, got: ${JSON.stringify(lines)}`);
    assert.match(blowout, /3 days left/);
  });

  it('uses the singular for a one-day remainder and a special phrase once the round is over', () => {
    const mk = (daysLeft) =>
      buildPlayoffCommentary({
        ...base,
        daysLeft,
        matchups: [{ label: 'SF2', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 400, bTotal: 100 }],
      }).find((l) => l.includes('300'));
    assert.match(mk(1), /1 day left/);
    assert.match(mk(0), /round already over/);
  });

  it('flags the closest matchup as a coin flip', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      matchups: [
        { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 210, bTotal: 200, aDelta: 10, bDelta: 5 },
      ],
    });
    assert.ok(
      lines.some((l) => /coin flip|separate/.test(l)),
      JSON.stringify(lines)
    );
  });

  it('credits the day’s biggest haul only when no earlier line already named him', () => {
    const matchups = [
      { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 500, bTotal: 460, aDelta: 90, bDelta: 10 },
      { label: 'SF2', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 300, bTotal: 290, aDelta: 12, bDelta: 8 },
    ];
    const lines = buildPlayoffCommentary({
      ...base,
      matchups,
      dailyTotals: { 'Daniel Kortan': 90, 'Alex Thalacker': 10, 'Jamie Rogers': 12, 'Ryan Sullivan': 8 },
    });
    // SF1 (40 apart) is not a nailbiter, SF2 (10 apart) is — so Daniel is unnamed until the
    // big-day line picks him up.
    assert.ok(
      lines.some((l) => l.includes('Daniel') && /90/.test(l)),
      JSON.stringify(lines)
    );
  });

  it('mocks a manager who did essentially nothing', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      matchups: [
        { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 500, bTotal: 460, aDelta: 30, bDelta: 0 },
      ],
      dailyTotals: { 'Daniel Kortan': 30, 'Alex Thalacker': 0 },
    });
    assert.ok(
      lines.some((l) => l.includes('Alex') && /:zzz:/.test(l)),
      JSON.stringify(lines)
    );
  });

  it('adds exactly one history line, from the highest-priority pattern in the field', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      matchups: [
        { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 500, bTotal: 460, aDelta: 30, bDelta: 25 },
      ],
      histories: {
        'Daniel Kortan': history('Daniel Kortan', { titleCount: 2, lastTitle: 2019 }),
        'Alex Thalacker': history('Alex Thalacker', { neverMadeFinals: true, qfExitCount: 4, finalsAppearances: 0 }),
      },
    });
    // :ticket: marks the never-made-a-Final rule, :hourglass: the title-drought rule.
    const histLines = lines.filter((l) => l.startsWith(':ticket:') || l.startsWith(':hourglass:'));
    assert.equal(histLines.length, 1, JSON.stringify(lines));
    // 'never-final' outranks 'drought' in the bank, so Alex's line wins.
    assert.ok(histLines[0].startsWith(':ticket:'), histLines[0]);
    assert.match(histLines[0], /Alex/);
  });

  it('skips history entirely when nobody has a pattern worth naming', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      matchups: [
        { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 500, bTotal: 460, aDelta: 30, bDelta: 25 },
      ],
      histories: { 'Daniel Kortan': history('Daniel Kortan'), 'Alex Thalacker': history('Alex Thalacker') },
    });
    assert.ok(!lines.some((l) => /Cup|Final|playoff round/.test(l)), JSON.stringify(lines));
  });

  it('only tells the serial-quarterfinalist joke during the quarterfinals', () => {
    const h = {
      'Jamie Rogers': history('Jamie Rogers', { qfExitCount: 5, neverMadeFinals: true, finalsAppearances: 0 }),
    };
    const matchups = [
      { label: 'X', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 300, bTotal: 280, aDelta: 20, bDelta: 20 },
    ];
    const qf = buildPlayoffCommentary({ ...base, round: 'QF', roundLabel: 'Quarterfinals', matchups, histories: h });
    const sf = buildPlayoffCommentary({ ...base, matchups, histories: h });
    // :chart_with_downwards_trend: is the serial-quarterfinalist rule's marker.
    assert.ok(
      qf.some((l) => l.startsWith(':chart_with_downwards_trend:')),
      JSON.stringify(qf)
    );
    assert.ok(!sf.some((l) => l.startsWith(':chart_with_downwards_trend:')), JSON.stringify(sf));
  });

  it('does not tell a 3rd-place-game player he is one win from his first Final', () => {
    const h = {
      'Jamie Rogers': history('Jamie Rogers', { neverMadeFinals: true, finalsAppearances: 0, qfExitCount: 4 }),
    };
    const championship = buildPlayoffCommentary({
      ...base,
      round: 'Finals',
      roundLabel: 'Finals',
      matchups: [
        {
          label: 'Championship',
          a: 'Jamie Rogers',
          b: 'Ryan Sullivan',
          aTotal: 300,
          bTotal: 290,
          aDelta: 20,
          bDelta: 20,
        },
      ],
      histories: h,
    });
    const thirdPlace = buildPlayoffCommentary({
      ...base,
      round: 'Finals',
      roundLabel: 'Finals',
      matchups: [
        { label: '3rd Place', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 300, bTotal: 290, aDelta: 20, bDelta: 20 },
      ],
      histories: h,
    });
    assert.ok(
      championship.some((l) => l.startsWith(':ticket:')),
      JSON.stringify(championship)
    );
    assert.ok(!thirdPlace.some((l) => l.startsWith(':ticket:')), JSON.stringify(thirdPlace));
  });

  it('respects maxLines', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      maxLines: 2,
      matchups: [
        {
          label: 'SF1',
          a: 'Daniel Kortan',
          b: 'Alex Thalacker',
          aTotal: 148.4,
          bTotal: 109.3,
          aDelta: 48.4,
          bDelta: 4,
        },
        { label: 'SF2', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 400, bTotal: 100, aDelta: 30, bDelta: 0 },
      ],
      dailyTotals: { 'Daniel Kortan': 48.4, 'Alex Thalacker': 4, 'Jamie Rogers': 30, 'Ryan Sullivan': 0 },
      histories: { 'Jamie Rogers': history('Jamie Rogers', { neverMadeFinals: true, finalsAppearances: 0 }) },
    });
    assert.equal(lines.length, 2);
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    const args = {
      ...base,
      matchups: [
        {
          label: 'SF1',
          a: 'Daniel Kortan',
          b: 'Alex Thalacker',
          aTotal: 148.4,
          bTotal: 109.3,
          aDelta: 48.4,
          bDelta: 4,
        },
      ],
    };
    assert.deepEqual(buildPlayoffCommentary({ ...args, seed: 7 }), buildPlayoffCommentary({ ...args, seed: 7 }));
    const variants = new Set([1, 2, 3].map((s) => buildPlayoffCommentary({ ...args, seed: s })[0]));
    assert.ok(variants.size > 1, 'different seeds pick different templates');
  });

  it('never doubles a period after an initialled short name, in any template', () => {
    const shortNames = {
      'Ryan Sullivan': 'Ryan S.',
      'Ryan Courville': 'Ryan C.',
      'Jamie Rogers': 'Jamie R.',
      'Daniel Kortan': 'Daniel K.',
    };
    const histories = {
      'Ryan Sullivan': history('Ryan Sullivan', { neverMadeFinals: true, finalsAppearances: 0, qfExitCount: 4 }),
      'Ryan Courville': history('Ryan Courville', { titleCount: 2, lastTitle: 2018, titles: [2017, 2018] }),
      'Jamie Rogers': history('Jamie Rogers', { runnerUps: [2019, 2021], titleCount: 0 }),
      'Daniel Kortan': history('Daniel Kortan', { neverPastQF: true, playoffAppearances: 5 }),
    };
    // Sweep a range of seeds and score shapes so every bank and every phrasing gets exercised.
    const shapes = [
      { aTotal: 148.4, bTotal: 109.3, aDelta: 48.4, bDelta: 4 }, // flip
      { aTotal: 400, bTotal: 100, aDelta: 30, bDelta: 0 }, // blowout + dead day
      { aTotal: 210, bTotal: 200, aDelta: 90, bDelta: 5 }, // nailbiter + big day
      { aTotal: 110, bTotal: 100, aDelta: 10, bDelta: 0 }, // tie broken
    ];
    for (let seed = 0; seed < 40; seed++) {
      for (const round of ['QF', 'SF', 'Finals']) {
        for (const shape of shapes) {
          const lines = buildPlayoffCommentary({
            round,
            roundLabel: round,
            year: 2026,
            daysLeft: 4,
            seed,
            shortNames,
            histories,
            matchups: [
              { label: 'M1', a: 'Ryan Sullivan', b: 'Ryan Courville', ...shape },
              { label: 'M2', a: 'Jamie Rogers', b: 'Daniel Kortan', ...shape },
            ],
            dailyTotals: {
              'Ryan Sullivan': shape.aDelta,
              'Ryan Courville': shape.bDelta,
              'Jamie Rogers': shape.aDelta,
              'Daniel Kortan': shape.bDelta,
            },
            maxLines: 10,
          });
          for (const line of lines) {
            assert.ok(!line.includes('..'), `doubled period (seed ${seed}, ${round}): ${line}`);
          }
        }
      }
    }
  });

  it('falls back to the full name when a manager is missing from the short-name map', () => {
    const lines = buildPlayoffCommentary({
      ...base,
      shortNames: {},
      matchups: [
        {
          label: 'SF1',
          a: 'Daniel Kortan',
          b: 'Alex Thalacker',
          aTotal: 148.4,
          bTotal: 109.3,
          aDelta: 48.4,
          bDelta: 4,
        },
      ],
    });
    assert.match(lines[0], /Daniel Kortan/);
  });
});

describe('commentaryFactSheet', () => {
  const args = {
    round: 'SF',
    roundLabel: 'Semifinals',
    year: 2026,
    daysLeft: 11,
    shortNames: SHORT,
    matchups: [
      { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 83, bTotal: 111, aDelta: 3, bDelta: 36 },
      { label: 'SF2', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 309, bTotal: 76, aDelta: 24, bDelta: 4 },
    ],
    dailyTotals: { 'Daniel Kortan': 3, 'Alex Thalacker': 36, 'Jamie Rogers': 24, 'Ryan Sullivan': 4 },
    histories: {
      'Jamie Rogers': history('Jamie Rogers', { neverMadeFinals: true, finalsAppearances: 0, qfExitCount: 5 }),
    },
  };

  it('returns null outside the playoff rounds and with no matchups', () => {
    assert.equal(commentaryFactSheet({ ...args, round: 'PP2' }), null);
    assert.equal(commentaryFactSheet({ ...args, matchups: [] }), null);
  });

  it('states both totals, both deltas and who leads, per matchup', () => {
    const sheet = commentaryFactSheet(args);
    assert.match(sheet, /SF1: Daniel 83 \(yesterday \+3\) vs Alex 111 \(yesterday \+36\)/);
    assert.match(sheet, /Alex leads by 28/);
    assert.match(sheet, /Jamie leads by 233/);
  });

  it('names a lead change and reports the previous morning\u2019s margin', () => {
    assert.match(commentaryFactSheet(args), /LEAD CHANGE yesterday: Daniel led by 5 the previous morning/);
  });

  it('marks a blowout as over and a tight one as a coin flip', () => {
    assert.match(commentaryFactSheet(args), /this one is effectively over/);
    const tight = commentaryFactSheet({
      ...args,
      matchups: [
        { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 210, bTotal: 200, aDelta: 5, bDelta: 5 },
      ],
    });
    assert.match(tight, /this one is a coin flip/);
    assert.ok(!/effectively over/.test(tight));
  });

  it('says whether the gap opened or closed when the lead held', () => {
    const closed = commentaryFactSheet({
      ...args,
      matchups: [
        { label: 'SF1', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 200, bTotal: 190, aDelta: 5, bDelta: 45 },
      ],
    });
    assert.match(closed, /the gap CLOSED by 40 yesterday \(was 50\)/);
    assert.match(commentaryFactSheet(args), /the gap WIDENED by 20 yesterday \(was 213\)/);
  });

  it('uses short names only, never a full name the model could echo', () => {
    const sheet = commentaryFactSheet(args);
    for (const full of ['Daniel Kortan', 'Alex Thalacker', 'Jamie Rogers', 'Ryan Sullivan']) {
      assert.ok(!sheet.includes(full), `fact sheet leaked the full name ${full}`);
    }
    assert.match(sheet, /Ryan S\./);
  });

  it('includes a career record only for managers a history was supplied for', () => {
    const sheet = commentaryFactSheet(args);
    assert.match(sheet, /Jamie: 8 seasons; no Cups; has NEVER reached a Final; 5 quarterfinal exits/);
    assert.ok(!/^- Daniel: \d+ seasons/m.test(sheet), 'no history supplied for Daniel');
  });

  it('drops the career section entirely when no histories are supplied', () => {
    const sheet = commentaryFactSheet({ ...args, histories: {} });
    assert.ok(!/CAREER RECORD/.test(sheet), sheet);
  });
});

describe('commentaryMentionsUnknownScore', () => {
  const sheet = 'Alex 111 (yesterday +36.4)\nJamie leads by 233.7';

  it('catches a decimal the facts never contained', () => {
    assert.equal(commentaryMentionsUnknownScore('Alex put up 99.9 yesterday', sheet), true);
  });

  it('passes a decimal that is in the facts', () => {
    assert.equal(commentaryMentionsUnknownScore('Alex put up 36.4 and leads', sheet), false);
    assert.equal(commentaryMentionsUnknownScore('Jamie leads by 233.7', sheet), false);
  });

  it('ignores whole numbers, which are ordinary prose', () => {
    assert.equal(commentaryMentionsUnknownScore('8 seasons, 2 of 3 matchups, 111 points', sheet), false);
  });

  it('matches across thousands separators in either direction', () => {
    assert.equal(commentaryMentionsUnknownScore('he is at 1,182.4', 'total 1182.4'), false);
    assert.equal(commentaryMentionsUnknownScore('he is at 1182.4', 'total 1,182.4'), false);
  });

  it('is false for text with no numbers at all', () => {
    assert.equal(commentaryMentionsUnknownScore('nobody did anything', sheet), false);
    assert.equal(commentaryMentionsUnknownScore('', sheet), false);
  });
});

describe('tidyCommentaryLine', () => {
  it('strips a bullet or number the model added', () => {
    assert.equal(tidyCommentaryLine('- :zap: Alex leads'), ':zap: Alex leads');
    assert.equal(tidyCommentaryLine('* :zap: Alex leads'), ':zap: Alex leads');
    assert.equal(tidyCommentaryLine('1. :zap: Alex leads'), ':zap: Alex leads');
    assert.equal(tidyCommentaryLine('2) :zap: Alex leads'), ':zap: Alex leads');
  });

  it('collapses the doubled period after an initialled name', () => {
    assert.equal(tidyCommentaryLine('Nobody told Ryan S..'), 'Nobody told Ryan S.');
  });

  it('leaves an ellipsis and an ordinary sentence alone', () => {
    assert.equal(tidyCommentaryLine('He waited... and lost.'), 'He waited... and lost.');
    assert.equal(tidyCommentaryLine('  Alex leads by 28.  '), 'Alex leads by 28.');
  });

  it('does not eat a hyphen that is part of the sentence', () => {
    assert.equal(tidyCommentaryLine(':coffin: 233-point lead'), ':coffin: 233-point lead');
  });
});

describe('hotTakesCacheKey / hotTakesCacheHit', () => {
  it('keys on the day AND the round', () => {
    assert.equal(hotTakesCacheKey('2026-08-05', 'SF'), '2026-08-05|SF');
    assert.notEqual(hotTakesCacheKey('2026-08-05', 'SF'), hotTakesCacheKey('2026-08-05', 'QF'));
    assert.notEqual(hotTakesCacheKey('2026-08-05', 'SF'), hotTakesCacheKey('2026-08-06', 'SF'));
  });

  it('is null when either half is missing, so nothing can accidentally match', () => {
    assert.equal(hotTakesCacheKey(null, 'SF'), null);
    assert.equal(hotTakesCacheKey('2026-08-05', null), null);
    assert.equal(hotTakesCacheHit({ key: null, lines: ['x'] }, null, 'SF'), false);
  });

  it('hits only for the same day and the same round', () => {
    const cached = { key: '2026-08-05|SF', lines: [':zap: a take'] };
    assert.equal(hotTakesCacheHit(cached, '2026-08-05', 'SF'), true);
    assert.equal(hotTakesCacheHit(cached, '2026-08-06', 'SF'), false);
    // The Monday a round rolls over: same "yesterday", new round.
    assert.equal(hotTakesCacheHit(cached, '2026-08-05', 'Finals'), false);
  });

  it('misses on an empty, absent or junk cache rather than rendering nothing', () => {
    assert.equal(hotTakesCacheHit(null, '2026-08-05', 'SF'), false);
    assert.equal(hotTakesCacheHit({}, '2026-08-05', 'SF'), false);
    assert.equal(hotTakesCacheHit({ key: '2026-08-05|SF', lines: [] }, '2026-08-05', 'SF'), false);
    assert.equal(hotTakesCacheHit({ key: '2026-08-05|SF' }, '2026-08-05', 'SF'), false);
    assert.equal(hotTakesCacheHit({ key: '2026-08-05|SF', lines: ['  '] }, '2026-08-05', 'SF'), false);
    assert.equal(hotTakesCacheHit({ key: '2026-08-05|SF', lines: [null] }, '2026-08-05', 'SF'), false);
  });
});

describe('emoji shortcodes', () => {
  const shortNames = { A: 'A', B: 'B', C: 'C', D: 'D' };
  const shapes = [
    { aTotal: 148.4, bTotal: 109.3, aDelta: 48.4, bDelta: 4 }, // flip
    { aTotal: 400, bTotal: 100, aDelta: 30, bDelta: 0 }, // blowout + dead day
    { aTotal: 210, bTotal: 200, aDelta: 90, bDelta: 5 }, // nailbiter + big day
    { aTotal: 110, bTotal: 100, aDelta: 10, bDelta: 0 }, // tie broken
    { aTotal: 100, bTotal: 100, aDelta: 10, bDelta: 10 }, // level
    // Lead held all day, margin between the nailbiter and blowout bars, one manager hauling and
    // the other asleep — the only shape where nothing else has already named them, which is what
    // the big-day and dead-day lines require.
    { aTotal: 300, bTotal: 240, aDelta: 50, bDelta: 2 },
  ];

  const run = (over = {}) =>
    buildPlayoffCommentary({
      round: 'SF',
      roundLabel: 'Semifinals',
      year: 2026,
      daysLeft: 4,
      seed: 0,
      shortNames,
      maxLines: 12,
      ...over,
    });

  // Slack renders an unrecognised shortcode as literal text. ":tickets:" shipped to the league
  // that way before this test existed — 🎫 is ":ticket:", singular. Nothing in the code can
  // catch that: it is valid JS, valid mrkdwn, and only wrong once Slack tries to draw it.
  it('no generated line ever leads with an unvetted shortcode', () => {
    const histories = {
      A: history('A', { neverMadeFinals: true, finalsAppearances: 0, qfExitCount: 5, seasonsPlayed: 9 }),
      B: history('B', { neverPastQF: true, playoffAppearances: 6 }),
      C: history('C', { titleCount: 2, lastTitle: 2018, titles: [2015, 2018], runnerUps: [2016, 2017] }),
      D: history('D', { sfExitCount: 4, lastYearInSemis: 2019, lastTitle: 2025 }),
    };
    for (let seed = 0; seed < 60; seed++) {
      for (const round of ['QF', 'SF', 'Finals']) {
        for (const label of ['SF1', 'Championship', '3rd Place']) {
          for (const shape of shapes) {
            const lines = run({
              round,
              roundLabel: round,
              seed,
              histories,
              matchups: [
                { label, a: 'A', b: 'B', ...shape },
                { label: 'M2', a: 'C', b: 'D', ...shape },
              ],
              dailyTotals: { A: shape.aDelta, B: shape.bDelta, C: shape.aDelta, D: shape.bDelta },
            });
            for (const line of lines) {
              const code = (line.match(/^:[a-z_0-9]+:/) || [])[0];
              assert.ok(code, `line does not start with a shortcode: ${line}`);
              assert.ok(SLACK_EMOJI.includes(code), `unvetted shortcode ${code} in: ${line}`);
            }
          }
        }
      }
    }
  });

  // Each history rule outranks the ones below it, so a broad sweep only ever shows the top few.
  // These isolate one rule at a time, which is what actually proves every entry in the list is
  // reachable — and therefore that every entry has been looked at.
  it('every vetted shortcode is reachable', () => {
    const seen = new Set();
    const collect = (lines) => lines.forEach((l) => seen.add((l.match(/^:[a-z_0-9]+:/) || [])[0]));

    for (const shape of shapes) {
      collect(
        run({
          matchups: [{ label: 'SF1', a: 'A', b: 'B', ...shape }],
          dailyTotals: { A: shape.aDelta, B: shape.bDelta },
        })
      );
    }

    const soloHistories = [
      ['QF', { qfExitCount: 4 }], // :chart_with_downwards_trend:
      ['SF', { neverMadeFinals: true, finalsAppearances: 0 }], // :ticket:
      ['SF', { lastTitle: 2025, titleCount: 1, titles: [2025] }], // :crown: (defending)
      ['SF', { lastTitle: 2020, titleCount: 2, titles: [2018, 2020] }], // :hourglass: (drought)
      ['SF', { runnerUps: [2019, 2021], titleCount: 0 }], // :second_place_medal:
      ['SF', { lastYearInSemis: 2020 }], // :sparkles:
      ['SF', { sfExitCount: 4, titleCount: 0 }], // :repeat:
    ];
    for (const [round, over] of soloHistories) {
      for (let seed = 0; seed < 6; seed++) {
        collect(
          run({
            round,
            roundLabel: round,
            seed,
            matchups: [{ label: 'M', a: 'A', b: 'B', aTotal: 260, bTotal: 200, aDelta: 30, bDelta: 25 }],
            histories: { A: history('A', over) },
          })
        );
      }
    }

    const missing = SLACK_EMOJI.filter((c) => !seen.has(c));
    assert.deepEqual(missing, [], `unreachable shortcodes (dead entries or a broken rule): ${missing.join(' ')}`);
  });

  it('leaves a line that already leads with a vetted shortcode alone', () => {
    assert.equal(enforceVettedEmoji(':boom: Alex went off'), ':boom: Alex went off');
    assert.equal(enforceVettedEmoji('  :ticket: 8 seasons  '), ':ticket: 8 seasons');
  });

  it('replaces a shortcode Slack would print as literal text', () => {
    // The exact bug that shipped: :tickets: is not a Slack shortcode.
    assert.equal(enforceVettedEmoji(':tickets: 8 seasons. No Finals.'), ':zap: 8 seasons. No Finals.');
    assert.equal(enforceVettedEmoji(':fire_engine_siren: he is done'), ':zap: he is done');
  });

  it('adds one to a line that has none', () => {
    assert.equal(enforceVettedEmoji('Alex leads by 28'), ':zap: Alex leads by 28');
  });

  it('honours a caller-chosen fallback and drops empty input', () => {
    assert.equal(enforceVettedEmoji(':nope: x', ':boom:'), ':boom: x');
    assert.equal(enforceVettedEmoji('   '), '');
    assert.equal(enforceVettedEmoji(null), '');
  });

  it('has no duplicates and every entry is well-formed', () => {
    assert.equal(new Set(SLACK_EMOJI).size, SLACK_EMOJI.length);
    for (const code of SLACK_EMOJI) assert.match(code, /^:[a-z_0-9]+:$/);
  });
});

describe('catchUpPace', () => {
  it('reports the target, the actual pace, and the multiple between them', () => {
    const p = catchUpPace({ margin: 233, daysLeft: 4, trailerTotal: 376, daysElapsed: 10 });
    assert.equal(p.needPerDay, 58.3);
    assert.equal(p.actualPerDay, 37.6);
    assert.equal(p.multiple, 1.6);
  });

  it('calls a comfortable chase comfortable, which is the misreading it exists to prevent', () => {
    // 7 a day for a manager averaging 48 is nothing. A bare "0.1x" invites the opposite joke.
    const p = catchUpPace({ margin: 28, daysLeft: 4, trailerTotal: 483, daysElapsed: 10 });
    assert.equal(p.multiple, 0.1);
    assert.match(p.verdict, /not the problem it looks like/);
  });

  it('grades a stretch and a hopeless case differently', () => {
    assert.match(catchUpPace({ margin: 233, daysLeft: 4, trailerTotal: 376, daysElapsed: 10 }).verdict, /real stretch/);
    assert.match(
      catchUpPace({ margin: 400, daysLeft: 2, trailerTotal: 100, daysElapsed: 10 }).verdict,
      /barring a miracle/
    );
  });

  it('handles a manager who has scored nothing', () => {
    const p = catchUpPace({ margin: 50, daysLeft: 3, trailerTotal: 0, daysElapsed: 10 });
    assert.equal(p.multiple, Infinity);
    assert.match(p.verdict, /scored nothing at all/);
  });

  it('returns null when the maths would be meaningless', () => {
    assert.equal(catchUpPace({ margin: 0, daysLeft: 4, trailerTotal: 100, daysElapsed: 5 }), null);
    assert.equal(catchUpPace({ margin: 50, daysLeft: 0, trailerTotal: 100, daysElapsed: 5 }), null);
    assert.equal(catchUpPace({ margin: 50, daysLeft: 4, trailerTotal: 100, daysElapsed: 0 }), null);
    assert.equal(catchUpPace(), null);
  });
});

describe('commentaryBudget', () => {
  const base = { round: 'SF', daysLeft: 11 };
  const quiet = {
    ...base,
    matchups: [{ label: 'SF1', a: 'A', b: 'B', aTotal: 300, bTotal: 240, aDelta: 20, bDelta: 18 }],
    dailyTotals: { A: 20, B: 18 },
  };

  it('gives a quiet day two takes', () => {
    assert.equal(commentaryBudget(quiet), 2);
  });

  it('gives an eventful day three', () => {
    const busy = {
      ...base,
      daysLeft: 3,
      matchups: [
        { label: 'SF1', a: 'A', b: 'B', aTotal: 148.4, bTotal: 109.3, aDelta: 48.4, bDelta: 4 }, // flip + big day
        { label: 'SF2', a: 'C', b: 'D', aTotal: 400, bTotal: 100, aDelta: 30, bDelta: 0 }, // blowout + dead day
      ],
      dailyTotals: { A: 48.4, B: 4, C: 30, D: 0 },
      underperformers: [{ manager: 'D', player: 'X', type: 'Batter', roundPerGame: 2, priorPerGame: 20, games: 6 }],
    };
    assert.equal(commentaryBudget(busy), 3);
  });

  it('never exceeds three or drops below two for a real round', () => {
    for (const daysLeft of [0, 1, 5, 14]) {
      const n = commentaryBudget({ ...quiet, daysLeft });
      assert.ok(n === 2 || n === 3, `budget was ${n}`);
    }
  });

  it('is zero outside the playoffs or with nothing to talk about', () => {
    assert.equal(commentaryBudget({ ...quiet, round: 'PP2' }), 0);
    assert.equal(commentaryBudget({ ...base, matchups: [] }), 0);
    assert.equal(commentaryBudget(), 0);
  });

  it('caps the bank at the budget it computes', () => {
    const lines = buildPlayoffCommentary({ ...quiet, seed: 3, shortNames: {}, maxLines: commentaryBudget(quiet) });
    assert.ok(lines.length <= 2, JSON.stringify(lines));
  });
});

describe('commentaryFactSheet — run-in and slumps', () => {
  const base = {
    round: 'SF',
    roundLabel: 'Semifinals',
    year: 2026,
    shortNames: SHORT,
    matchups: [
      { label: 'SF1', a: 'Jamie Rogers', b: 'Ryan Sullivan', aTotal: 609, bTotal: 376, aDelta: 24, bDelta: 4 },
    ],
    dailyTotals: { 'Jamie Rogers': 24, 'Ryan Sullivan': 4 },
  };

  it('adds the run-in only near the end of the round', () => {
    assert.ok(!/THE RUN-IN/.test(commentaryFactSheet({ ...base, daysLeft: 11, daysElapsed: 3 })));
    const late = commentaryFactSheet({ ...base, daysLeft: 4, daysElapsed: 10 });
    assert.match(late, /THE RUN-IN \(4 days left, 10 scored so far\)/);
    assert.match(late, /Ryan S\. needs 58\.3 per day/);
    assert.match(late, /Verdict:/);
  });

  it('omits the run-in when there is no scoring history to compare with', () => {
    assert.ok(!/THE RUN-IN/.test(commentaryFactSheet({ ...base, daysLeft: 4, daysElapsed: 0 })));
  });

  it('ranks the whole bracket only when there is more than one matchup', () => {
    assert.ok(!/ROUND TOTALS ACROSS THE WHOLE BRACKET/.test(commentaryFactSheet({ ...base, daysLeft: 9 })));
    const two = commentaryFactSheet({
      ...base,
      daysLeft: 9,
      matchups: [
        ...base.matchups,
        { label: 'SF2', a: 'Daniel Kortan', b: 'Alex Thalacker', aTotal: 483, bTotal: 511, aDelta: 3, bDelta: 36 },
      ],
    });
    assert.match(two, /ROUND TOTALS ACROSS THE WHOLE BRACKET/);
    // Best first.
    const order = two.slice(two.indexOf('ROUND TOTALS')).split('\n').slice(1, 5).join(' ');
    assert.ok(order.indexOf('Jamie') < order.indexOf('Ryan S.'), order);
  });

  it('lists slumping players with both rates, and omits the section when there are none', () => {
    assert.ok(!/PLAYERS GOING BACKWARDS/.test(commentaryFactSheet({ ...base, daysLeft: 9 })));
    const withSlump = commentaryFactSheet({
      ...base,
      daysLeft: 9,
      underperformers: [
        {
          manager: 'Ryan Sullivan',
          player: 'CJ Abrams',
          type: 'Batter',
          roundPerGame: 4.2,
          priorPerGame: 18.6,
          games: 9,
        },
      ],
    });
    assert.match(
      withSlump,
      /CJ Abrams \(Ryan S\., Batter\): 4\.2 per game this round vs 18\.6 before it, over 9 games/
    );
  });
});
