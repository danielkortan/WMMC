import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ODDS_WINDOW,
  oddsWindowForDate,
  BRACKET_ODDS_ROUNDS,
  bracketOddsWindowForDate,
  meanVariance,
  playerGameRate,
  APPEARANCE_PRIORS,
  APPEARANCE_RATE_FLOOR,
  expectedAppearanceRate,
  projectManager,
  currentQualification,
  makeNormalSampler,
  simulatePlayoffOdds,
  simulateBracketOdds,
  formatOddsPct,
  HOME_ADVANTAGE,
  PARK_FACTORS,
  computeTeamQualityFactors,
  gameFactor,
} from '../js/playoffOdds.js';
import { SEASON_SCHEDULE } from '../js/scoring.js';

// Deterministic uniform rng (LCG) so simulation tests are reproducible.
function makeLcg(seed = 42) {
  let state = seed >>> 0;
  return function rng() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// A full 16-week schedule_dates array with PP2 Week 4 = Jul 6–12 and
// PP2 Week 5 = Jul 13–19 (indexes 8 and 9 in SEASON_SCHEDULE).
function makeScheduleDates() {
  const dates = [];
  let day = new Date('2026-05-11T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const start = new Date(day);
    const end = new Date(day);
    end.setUTCDate(end.getUTCDate() + 6);
    dates.push({ start: iso(start), end: iso(end) });
    day.setUTCDate(day.getUTCDate() + 7);
  }
  return dates;
}

describe('oddsWindowForDate', () => {
  const scheduleDates = makeScheduleDates();
  const w4 = scheduleDates[8];
  const w5 = scheduleDates[9];

  it('is null before PP2 Week 4 starts', () => {
    assert.equal(oddsWindowForDate(scheduleDates, '2026-05-11'), null);
    const dayBefore = new Date(w4.start + 'T00:00:00Z');
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    assert.equal(oddsWindowForDate(scheduleDates, dayBefore.toISOString().slice(0, 10)), null);
  });

  it('is active from the first day of PP2 Week 4 through the last day of Week 5', () => {
    const atStart = oddsWindowForDate(scheduleDates, w4.start);
    assert.ok(atStart);
    assert.equal(atStart.round, 'PP2');
    assert.equal(atStart.week, ODDS_WINDOW.firstWeek);
    assert.equal(atStart.start, w4.start);
    assert.equal(atStart.end, w5.end);

    const inW5 = oddsWindowForDate(scheduleDates, w5.start);
    assert.ok(inW5);
    assert.equal(inW5.week, ODDS_WINDOW.lastWeek);
    assert.ok(oddsWindowForDate(scheduleDates, w5.end));
  });

  it('is null after pool play ends and when the schedule is missing', () => {
    const dayAfter = new Date(w5.end + 'T00:00:00Z');
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    assert.equal(oddsWindowForDate(scheduleDates, dayAfter.toISOString().slice(0, 10)), null);
    assert.equal(oddsWindowForDate([], '2026-07-06'), null);
    assert.equal(oddsWindowForDate(null, '2026-07-06'), null);
    // Schedule configured only through PP1 — no window entries for PP2 W4/W5.
    assert.equal(oddsWindowForDate(scheduleDates.slice(0, 5), '2026-07-06'), null);
  });
});

describe('bracketOddsWindowForDate', () => {
  const scheduleDates = makeScheduleDates();
  // SEASON_SCHEDULE: QF is indexes 10-11, SF 12-13, Finals 14-15.
  const qfW1 = scheduleDates[10];
  const qfW2 = scheduleDates[11];
  const sfW2 = scheduleDates[13];
  const finalsW2 = scheduleDates[15];

  it('is null during pool play and during a bracket round’s FIRST week', () => {
    assert.equal(bracketOddsWindowForDate(scheduleDates, scheduleDates[8].start), null);
    assert.equal(bracketOddsWindowForDate(scheduleDates, qfW1.start), null);
    assert.equal(bracketOddsWindowForDate(scheduleDates, qfW1.end), null);
  });

  it('opens on the first day of each bracket round’s final week and names that round', () => {
    for (const [dates, round] of [
      [qfW2, 'QF'],
      [sfW2, 'SF'],
      [finalsW2, 'Finals'],
    ]) {
      const atStart = bracketOddsWindowForDate(scheduleDates, dates.start);
      assert.ok(atStart, `expected a window on ${dates.start}`);
      assert.equal(atStart.round, round);
      assert.equal(atStart.week, 'Week 2');
      assert.equal(atStart.start, dates.start);
      assert.equal(atStart.end, dates.end);
      assert.ok(bracketOddsWindowForDate(scheduleDates, dates.end));
    }
  });

  it('is null after the Finals end, and whenever the schedule is unusable', () => {
    const dayAfter = new Date(finalsW2.end + 'T00:00:00Z');
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    assert.equal(bracketOddsWindowForDate(scheduleDates, dayAfter.toISOString().slice(0, 10)), null);
    assert.equal(bracketOddsWindowForDate([], qfW2.start), null);
    assert.equal(bracketOddsWindowForDate(null, qfW2.start), null);
    assert.equal(bracketOddsWindowForDate(scheduleDates, null), null);
    // Schedule configured only through QF Week 1 — no dates for any final week.
    assert.equal(bracketOddsWindowForDate(scheduleDates.slice(0, 11), qfW2.start), null);
  });

  it('reads "final week" off the schedule rather than hardcoding Week 2', () => {
    // A hypothetical three-week quarterfinal: the window must follow to Week 3.
    const schedule = [
      { round: 'QF', week: 'Week 1' },
      { round: 'QF', week: 'Week 2' },
      { round: 'QF', week: 'Week 3' },
    ];
    const dates = [
      { start: '2026-07-20', end: '2026-07-26' },
      { start: '2026-07-27', end: '2026-08-02' },
      { start: '2026-08-03', end: '2026-08-09' },
    ];
    assert.equal(bracketOddsWindowForDate(dates, '2026-07-28', schedule), null);
    const w3 = bracketOddsWindowForDate(dates, '2026-08-05', schedule);
    assert.ok(w3);
    assert.equal(w3.week, 'Week 3');
  });

  it('covers exactly the three bracket rounds', () => {
    assert.deepEqual(BRACKET_ODDS_ROUNDS, ['QF', 'SF', 'Finals']);
  });
});

describe('meanVariance', () => {
  it('handles empty, single, and multi-element inputs', () => {
    assert.deepEqual(meanVariance([]), { mean: 0, variance: 0, n: 0 });
    assert.deepEqual(meanVariance([7]), { mean: 7, variance: 0, n: 1 });
    const { mean, variance, n } = meanVariance([2, 4, 6]);
    assert.equal(mean, 4);
    assert.equal(variance, 4); // sample variance: ((-2)^2 + 0 + 2^2) / 2
    assert.equal(n, 3);
  });

  it('ignores non-numeric entries', () => {
    const { mean, n } = meanVariance([3, null, undefined, NaN, 5]);
    assert.equal(mean, 4);
    assert.equal(n, 2);
  });
});

describe('playerGameRate', () => {
  const baseline = { mean: 4, variance: 9 };

  it('returns the baseline for a player with no games', () => {
    const r = playerGameRate([], baseline);
    assert.equal(r.mean, 4);
    assert.equal(r.variance, 9);
    assert.equal(r.games, 0);
  });

  it('shrinks a small sample toward the baseline', () => {
    // One 20-point game with k=5: (20*1 + 4*5) / 6 = 40/6
    const r = playerGameRate([20], baseline, 5);
    assert.ok(Math.abs(r.mean - 40 / 6) < 1e-9);
    assert.ok(r.mean < 20 && r.mean > 4);
    // Single game has no variance information — baseline variance carries through.
    assert.ok(Math.abs(r.variance - 9) < 1e-9);
  });

  it('converges to the sample mean as games accumulate', () => {
    const many = Array(200).fill(10);
    const r = playerGameRate(many, baseline, 5);
    assert.ok(Math.abs(r.mean - 10) < 0.2);
    assert.equal(r.games, 200);
  });
});

describe('expectedAppearanceRate', () => {
  it('files a starter near the rotation rate and an everyday bat near 1', () => {
    // 20 starts in 110 team games, shrunk toward the pitcher prior.
    const starter = expectedAppearanceRate(20, 110, APPEARANCE_PRIORS.pitcher);
    assert.ok(starter > 0.15 && starter < 0.25, `starter rate was ${starter}`);
    // 100 games out of 110 — an everyday bat, and the prior barely moves it.
    const everyday = expectedAppearanceRate(100, 110, APPEARANCE_PRIORS.batter);
    assert.ok(everyday > 0.85 && everyday <= 1, `everyday rate was ${everyday}`);
    // A reliever lands between the two.
    const reliever = expectedAppearanceRate(45, 110, APPEARANCE_PRIORS.pitcher);
    assert.ok(reliever > starter && reliever < everyday);
  });

  it('falls back to the positional prior when the span is unknown', () => {
    assert.equal(expectedAppearanceRate(20, 0, APPEARANCE_PRIORS.pitcher), APPEARANCE_PRIORS.pitcher);
    assert.equal(expectedAppearanceRate(20, null, APPEARANCE_PRIORS.batter), APPEARANCE_PRIORS.batter);
    assert.equal(expectedAppearanceRate(20, -5, APPEARANCE_PRIORS.batter), APPEARANCE_PRIORS.batter);
  });

  it('pulls a tiny sample toward the prior instead of to 0 or 1', () => {
    // One appearance in one team game is not a 100% player.
    assert.ok(expectedAppearanceRate(1, 1, APPEARANCE_PRIORS.batter) < 0.95);
    // Zero appearances over a couple of games is not a 0% player either.
    assert.ok(expectedAppearanceRate(0, 2, APPEARANCE_PRIORS.batter) > 0.5);
  });

  it('never returns a rate outside (floor, 1]', () => {
    assert.equal(expectedAppearanceRate(0, 100000, 0), APPEARANCE_RATE_FLOOR);
    assert.equal(expectedAppearanceRate(100, 10, APPEARANCE_PRIORS.batter), 1);
  });
});

describe('projectManager', () => {
  it('reduces to mean * games / variance * games when every factor is neutral (1.0)', () => {
    const neutral = (n) => Array(n).fill(1);
    const proj = projectManager([
      { mean: 5, variance: 4, gameFactors: neutral(10) },
      { mean: 3, variance: 2, gameFactors: neutral(5) },
      { mean: 9, variance: 9, gameFactors: neutral(0) },
    ]);
    assert.equal(proj.mean, 65);
    assert.equal(proj.variance, 50);
    assert.equal(proj.games, 15);
  });

  it('scales mean linearly and variance by the square of each game factor', () => {
    // mean: 1 * (2 + 3) = 5. variance: 1 * (2^2 + 3^2) = 13.
    const proj = projectManager([{ mean: 1, variance: 1, gameFactors: [2, 3] }]);
    assert.equal(proj.mean, 5);
    assert.equal(proj.variance, 13);
    assert.equal(proj.games, 2);
  });

  it('handles an empty roster and entries with no gameFactors', () => {
    assert.deepEqual(projectManager([]), { mean: 0, variance: 0, games: 0 });
    assert.deepEqual(projectManager([{ mean: 5, variance: 4 }]), { mean: 0, variance: 0, games: 0 });
  });

  it('treats a missing appearanceRate as 1, so old callers are unchanged', () => {
    const factors = [1, 1.2, 0.9];
    const withoutRate = projectManager([{ mean: 5, variance: 4, gameFactors: factors }]);
    const withRateOne = projectManager([{ mean: 5, variance: 4, gameFactors: factors, appearanceRate: 1 }]);
    assert.deepEqual(withoutRate, withRateOne);
  });

  it('scales the projection down by the appearance rate — a starter is not his rotation', () => {
    // 10 remaining team games, a per-start mean of 20, but he only takes every fifth turn.
    const proj = projectManager([{ mean: 20, variance: 100, gameFactors: Array(10).fill(1), appearanceRate: 0.2 }]);
    assert.ok(Math.abs(proj.mean - 40) < 1e-9); // 20 * 0.2 * 10
    assert.ok(Math.abs(proj.games - 2) < 1e-9); // EXPECTED starts, not team games
    // Var per game = p*sigma^2 + p(1-p)*mu^2 = 0.2*100 + 0.16*400 = 84, over 10 games.
    assert.ok(Math.abs(proj.variance - 840) < 1e-9);
  });

  it('carries the appearance risk itself in the variance, not just the scaled-down mean', () => {
    // Same expected production either way (10 games at p=0.2 vs 2 games at p=1), but the
    // player who might get one start or three is the more uncertain of the two.
    const uncertain = projectManager([
      { mean: 20, variance: 100, gameFactors: Array(10).fill(1), appearanceRate: 0.2 },
    ]);
    const certain = projectManager([{ mean: 20, variance: 100, gameFactors: Array(2).fill(1), appearanceRate: 1 }]);
    assert.ok(Math.abs(uncertain.mean - certain.mean) < 1e-9);
    assert.ok(uncertain.variance > certain.variance);
  });

  it('clamps a nonsensical appearance rate into [0, 1]', () => {
    const over = projectManager([{ mean: 5, variance: 1, gameFactors: [1, 1], appearanceRate: 4 }]);
    assert.equal(over.mean, 10);
    assert.equal(over.games, 2);
    const under = projectManager([{ mean: 5, variance: 1, gameFactors: [1, 1], appearanceRate: -2 }]);
    assert.deepEqual(under, { mean: 0, variance: 0, games: 0 });
  });
});

describe('simulateBracketOdds', () => {
  const pairs = [
    { label: 'SF1', a: 'Ahead', b: 'Behind' },
    { label: 'SF2', a: 'Even1', b: 'Even2' },
  ];

  it('gives a big lead with little time left a near-certain matchup win', () => {
    const res = simulateBracketOdds({
      pairs: [pairs[0]],
      totals: { Ahead: 500, Behind: 300 },
      projections: { Ahead: { mean: 40, variance: 100 }, Behind: { mean: 40, variance: 100 } },
      sims: 4000,
      rng: makeLcg(7),
    });
    assert.equal(res.sims, 4000);
    assert.ok(res.managers.Ahead.advance > 0.99, `got ${res.managers.Ahead.advance}`);
    assert.ok(Math.abs(res.managers.Ahead.advance + res.managers.Behind.advance - 1) < 1e-9);
  });

  it('reads a genuine coin-flip as one', () => {
    const res = simulateBracketOdds({
      pairs: [pairs[1]],
      totals: { Even1: 400, Even2: 400 },
      projections: { Even1: { mean: 50, variance: 900 }, Even2: { mean: 50, variance: 900 } },
      sims: 6000,
      rng: makeLcg(11),
    });
    assert.ok(Math.abs(res.managers.Even1.advance - 0.5) < 0.06, `got ${res.managers.Even1.advance}`);
  });

  it('lets a projection overturn a deficit when there is enough baseball left', () => {
    const res = simulateBracketOdds({
      pairs: [{ label: 'QF1', a: 'Trailing', b: 'Leading' }],
      totals: { Trailing: 380, Leading: 400 },
      // Trailing is 20 back but projects 120 more points over the rest of the round.
      projections: { Trailing: { mean: 200, variance: 400 }, Leading: { mean: 80, variance: 400 } },
      sims: 4000,
      rng: makeLcg(3),
    });
    assert.ok(res.managers.Trailing.advance > 0.9, `got ${res.managers.Trailing.advance}`);
  });

  it('resolves an exact tie by seed, exactly as the live bracket does', () => {
    // Zero variance and identical totals/projections means every sim ties.
    const res = simulateBracketOdds({
      pairs: [{ label: 'QF1', a: 'LowSeed', b: 'HighSeed' }],
      totals: { LowSeed: 400, HighSeed: 400 },
      projections: { LowSeed: { mean: 10, variance: 0 }, HighSeed: { mean: 10, variance: 0 } },
      seedRank: { LowSeed: 8, HighSeed: 1 },
      sims: 100,
      rng: makeLcg(5),
    });
    assert.equal(res.managers.HighSeed.advance, 1);
    assert.equal(res.managers.LowSeed.advance, 0);
    // With no seeds known at all it still has to pick someone, deterministically.
    const noSeeds = simulateBracketOdds({
      pairs: [{ label: 'QF1', a: 'First', b: 'Second' }],
      totals: { First: 400, Second: 400 },
      projections: { First: { mean: 10, variance: 0 }, Second: { mean: 10, variance: 0 } },
      sims: 50,
      rng: makeLcg(5),
    });
    assert.equal(noSeeds.managers.First.advance, 1);
  });

  it('simulates every pair in the round and reports each manager once', () => {
    const res = simulateBracketOdds({
      pairs,
      totals: { Ahead: 500, Behind: 300, Even1: 400, Even2: 400 },
      projections: {},
      sims: 500,
      rng: makeLcg(13),
    });
    assert.deepEqual(Object.keys(res.managers).sort(), ['Ahead', 'Behind', 'Even1', 'Even2']);
    for (const o of Object.values(res.managers)) assert.ok(o.advance >= 0 && o.advance <= 1);
  });

  it('treats a manager with no projection as simply not scoring again', () => {
    const res = simulateBracketOdds({
      pairs: [{ label: 'QF1', a: 'Live', b: 'Done' }],
      totals: { Live: 390, Done: 400 },
      projections: { Live: { mean: 50, variance: 0 } },
      sims: 200,
      rng: makeLcg(17),
    });
    assert.equal(res.managers.Live.advance, 1); // 390 + 50 > 400 + 0
  });

  it('ignores malformed pairs and survives an empty round', () => {
    const res = simulateBracketOdds({
      pairs: [{ label: 'QF1', a: 'Solo' }, null, { label: 'QF2' }],
      totals: { Solo: 1 },
      sims: 10,
      rng: makeLcg(19),
    });
    assert.deepEqual(res.managers, {});
    assert.deepEqual(simulateBracketOdds({ pairs: null, sims: 10, rng: makeLcg(19) }).managers, {});
  });
});

describe('computeTeamQualityFactors', () => {
  it('rates a team above/below a league average built only from valid entries', () => {
    const q = computeTeamQualityFactors({
      Weak: { era: 6.0, runsPerGame: 3.0 }, // bad pitching, weak offense
      Avg: { era: 4.0, runsPerGame: 5.0 },
      Strong: { era: 2.0, runsPerGame: 7.0 }, // great pitching, strong offense
      Unknown: {}, // no usable stats — excluded from the league average
    });
    // League avg era = (6+4+2)/3 = 4, avg rpg = (3+5+7)/3 = 5.
    assert.equal(q.Weak.pitchingRelative, 1.15); // raw 6/4=1.5, clamped to OPPONENT_FACTOR_CLAMP max
    assert.equal(q.Strong.pitchingRelative, 0.85); // 2/4=0.5, clamped to min
    assert.ok(Math.abs(q.Avg.pitchingRelative - 1) < 1e-9);
    assert.equal(q.Weak.hittingRelative, 0.85); // 3/5=0.6, clamped
    assert.equal(q.Strong.hittingRelative, 1.15); // 7/5=1.4, clamped
    assert.equal(q.Unknown.pitchingRelative, 1);
    assert.equal(q.Unknown.hittingRelative, 1);
  });

  it('returns neutral factors for everyone when no team has usable stats', () => {
    const q = computeTeamQualityFactors({ A: {}, B: { era: -1 } });
    assert.equal(q.A.pitchingRelative, 1);
    assert.equal(q.B.hittingRelative, 1);
  });

  it('handles an empty input', () => {
    assert.deepEqual(computeTeamQualityFactors({}), {});
    assert.deepEqual(computeTeamQualityFactors(undefined), {});
  });
});

describe('gameFactor', () => {
  const teamQuality = {
    WeakPitching: { pitchingRelative: 1.15, hittingRelative: 1 },
    StrongPitching: { pitchingRelative: 0.85, hittingRelative: 1 },
    StrongHitting: { pitchingRelative: 1, hittingRelative: 1.15 },
  };
  const parks = { HITTER_PARK: 1.1, PITCHER_PARK: 0.9 };

  it('boosts a hitter against weak pitching and suppresses them against strong pitching', () => {
    const vsWeak = gameFactor('batter', { opponent: 'WeakPitching', isHome: true, venueTeam: null }, teamQuality, {});
    const vsStrong = gameFactor(
      'batter',
      { opponent: 'StrongPitching', isHome: true, venueTeam: null },
      teamQuality,
      {}
    );
    assert.ok(vsWeak > vsStrong, `${vsWeak} should exceed ${vsStrong}`);
  });

  it('suppresses a pitcher against a strong offense', () => {
    const neutralOpp = gameFactor('pitcher', { opponent: null, isHome: true, venueTeam: null }, teamQuality, {});
    const vsStrongHitting = gameFactor(
      'pitcher',
      { opponent: 'StrongHitting', isHome: true, venueTeam: null },
      teamQuality,
      {}
    );
    assert.ok(vsStrongHitting < neutralOpp, `${vsStrongHitting} should be below neutral ${neutralOpp}`);
  });

  it('applies home/away in the same direction for both player types', () => {
    const home = gameFactor('batter', { opponent: null, isHome: true, venueTeam: null }, {}, {});
    const away = gameFactor('batter', { opponent: null, isHome: false, venueTeam: null }, {}, {});
    assert.ok(Math.abs(home - (1 + HOME_ADVANTAGE)) < 1e-9);
    assert.ok(Math.abs(away - (1 - HOME_ADVANTAGE)) < 1e-9);
    assert.ok(home > away);
  });

  it('applies park factor directly to batters and inversely to pitchers', () => {
    const batterHitterPark = gameFactor(
      'batter',
      { opponent: null, isHome: true, venueTeam: 'HITTER_PARK' },
      {},
      parks
    );
    const pitcherHitterPark = gameFactor(
      'pitcher',
      { opponent: null, isHome: true, venueTeam: 'HITTER_PARK' },
      {},
      parks
    );
    assert.ok(batterHitterPark > 1 + HOME_ADVANTAGE); // park boost stacks on top of the home boost
    assert.ok(pitcherHitterPark < 1); // hitter-friendly park drags the pitcher below neutral despite being home
  });

  it('falls back to neutral for an unknown opponent/venue and clamps combined extremes', () => {
    const unknown = gameFactor('batter', { opponent: 'NoSuchTeam', isHome: true, venueTeam: 'NoSuchPark' }, {}, {});
    assert.ok(Math.abs(unknown - (1 + HOME_ADVANTAGE)) < 1e-9);

    // Stack every extreme in the batter's favor — must still clamp to GAME_FACTOR_CLAMP max (1.5).
    const extreme = gameFactor(
      'batter',
      { opponent: 'WeakPitching', isHome: true, venueTeam: 'COL' },
      teamQuality,
      PARK_FACTORS
    );
    assert.ok(extreme <= 1.5);
  });

  it('handles a null/undefined game gracefully', () => {
    assert.equal(gameFactor('batter', null, {}, {}), 1 - HOME_ADVANTAGE);
    assert.equal(gameFactor('batter', undefined, {}, {}), 1 - HOME_ADVANTAGE);
  });
});

// Six managers in two pools; bracket of 4 keeps the wildcard math visible.
function sixManagerEntries() {
  return [
    { manager: 'A1', pool: '1', pp1: 300, pp2: 200 }, // PP1 leader pool 1
    { manager: 'A2', pool: '1', pp1: 250, pp2: 260 }, // PP2 leader pool 1
    { manager: 'A3', pool: '1', pp1: 100, pp2: 120 },
    { manager: 'B1', pool: '2', pp1: 280, pp2: 150 }, // PP1 leader pool 2
    { manager: 'B2', pool: '2', pp1: 200, pp2: 210 }, // PP2 leader pool 2
    { manager: 'B3', pool: '2', pp1: 260, pp2: 190 }, // best non-leader total (450)
  ];
}

describe('currentQualification', () => {
  it('identifies pool leaders, wildcards, and the cut line', () => {
    const q = currentQualification(sixManagerEntries(), 5);
    assert.deepEqual([...q.pp1Leaders].sort(), ['A1', 'B1']);
    assert.deepEqual([...q.pp2Leaders].sort(), ['A2', 'B2']);
    // 4 unique leaders + 1 wildcard (B3, total 450 beats A3's 220)
    assert.equal(q.qualifierNames.length, 5);
    assert.ok(q.qualifierNames.includes('B3'));
    assert.ok(!q.qualifierNames.includes('A3'));
    assert.equal(q.cutTotal, 450);
    assert.equal(q.pp2LeaderByPool['1'].manager, 'A2');
    assert.equal(q.pp2LeaderByPool['2'].pp2, 210);
  });

  // server.js' copy of currentQualification gained pp1LeaderByPool in #415 so the
  // corrections-sweep Slack alert could name WHICH pool a winner flipped in. This copy is the
  // canonical, unit-tested one; the two must stay identical (CLAUDE.md), so pin the shape here.
  it('names the PP1 leader of each pool alongside their score', () => {
    const q = currentQualification(sixManagerEntries(), 5);
    assert.deepEqual(q.pp1LeaderByPool['1'], { manager: 'A1', pp1: 300 });
    assert.deepEqual(q.pp1LeaderByPool['2'], { manager: 'B1', pp1: 280 });
  });

  it('omits a pool from pp1LeaderByPool when nobody has scored', () => {
    const q = currentQualification(
      [
        { manager: 'X', pool: '1', pp1: 0, pp2: 0 },
        { manager: 'Y', pool: '2', pp1: 10, pp2: 0 },
      ],
      2
    );
    assert.equal(q.pp1LeaderByPool['1'], undefined);
    assert.deepEqual(q.pp1LeaderByPool['2'], { manager: 'Y', pp1: 10 });
  });

  it('requires a positive score to lead or take a wildcard', () => {
    const q = currentQualification(
      [
        { manager: 'X', pool: '1', pp1: 0, pp2: 0 },
        { manager: 'Y', pool: '1', pp1: 10, pp2: 0 },
      ],
      2
    );
    assert.deepEqual([...q.pp1Leaders], ['Y']);
    assert.equal(q.pp2Leaders.size, 0);
    assert.deepEqual(q.qualifierNames, ['Y']);
  });
});

describe('makeNormalSampler', () => {
  it('produces roughly standard-normal draws', () => {
    const normal = makeNormalSampler(makeLcg(7));
    const draws = Array.from({ length: 20000 }, () => normal());
    const { mean, variance } = meanVariance(draws);
    assert.ok(Math.abs(mean) < 0.05, `mean ${mean}`);
    assert.ok(Math.abs(variance - 1) < 0.05, `variance ${variance}`);
  });
});

describe('simulatePlayoffOdds', () => {
  it('is exact when every projection has zero variance (matches currentQualification)', () => {
    const entries = sixManagerEntries();
    const { managers } = simulatePlayoffOdds({
      entries,
      projections: {}, // no remaining production at all
      bracketSize: 5,
      sims: 50,
      rng: makeLcg(1),
    });
    const q = currentQualification(entries, 5);
    for (const e of entries) {
      const expected = q.qualifierNames.includes(e.manager) ? 1 : 0;
      assert.equal(managers[e.manager].make, expected, e.manager);
    }
    assert.equal(managers.A1.lockedPP1, true);
    assert.equal(managers.B1.lockedPP1, true);
    assert.equal(managers.A3.lockedPP1, false);
  });

  it('banks PP1 pool winners at 100% regardless of remaining variance', () => {
    const entries = sixManagerEntries();
    const projections = Object.fromEntries(entries.map((e) => [e.manager, { mean: 100, variance: 2500 }]));
    const { managers } = simulatePlayoffOdds({
      entries,
      projections,
      bracketSize: 5,
      sims: 2000,
      rng: makeLcg(2),
    });
    assert.equal(managers.A1.make, 1);
    assert.equal(managers.B1.make, 1);
  });

  it('gives a dominant PP2 lead near-certain pool-win odds and a huge deficit near-zero', () => {
    const entries = [
      { manager: 'Leader', pool: '1', pp1: 100, pp2: 900 },
      { manager: 'Trailer', pool: '1', pp1: 90, pp2: 100 },
      { manager: 'Other', pool: '2', pp1: 120, pp2: 300 },
    ];
    const projections = {
      Leader: { mean: 100, variance: 400 },
      Trailer: { mean: 100, variance: 400 },
      Other: { mean: 100, variance: 400 },
    };
    const { managers } = simulatePlayoffOdds({
      entries,
      projections,
      bracketSize: 2,
      sims: 4000,
      rng: makeLcg(3),
    });
    assert.ok(managers.Leader.winPP2Pool > 0.999, `leader ${managers.Leader.winPP2Pool}`);
    assert.ok(managers.Trailer.winPP2Pool < 0.001, `trailer ${managers.Trailer.winPP2Pool}`);
  });

  it('gives evenly matched pool rivals ~50/50 PP2-pool odds', () => {
    const entries = [
      { manager: 'Even1', pool: '1', pp1: 200, pp2: 400 },
      { manager: 'Even2', pool: '1', pp1: 210, pp2: 400 },
      { manager: 'Solo', pool: '2', pp1: 500, pp2: 500 },
    ];
    const projections = {
      Even1: { mean: 150, variance: 900 },
      Even2: { mean: 150, variance: 900 },
      Solo: { mean: 150, variance: 900 },
    };
    const { managers } = simulatePlayoffOdds({
      entries,
      projections,
      bracketSize: 3,
      sims: 20000,
      rng: makeLcg(4),
    });
    assert.ok(Math.abs(managers.Even1.winPP2Pool - 0.5) < 0.03, `${managers.Even1.winPP2Pool}`);
    assert.ok(Math.abs(managers.Even2.winPP2Pool - 0.5) < 0.03, `${managers.Even2.winPP2Pool}`);
    // All three fit the bracket (2 PP1 winners + PP2 winners + wildcard fill).
    assert.equal(managers.Even1.make, 1);
    assert.equal(managers.Even2.make, 1);
  });

  it('credits wildcard qualification separately from pool wins', () => {
    // C trails both pool races hopelessly but holds a monster combined total —
    // should qualify via wildcard in essentially every sim.
    const entries = [
      { manager: 'P1', pool: '1', pp1: 500, pp2: 500 },
      { manager: 'C', pool: '1', pp1: 480, pp2: 250 },
      { manager: 'D', pool: '1', pp1: 100, pp2: 90 },
      { manager: 'P2', pool: '2', pp1: 400, pp2: 400 },
      { manager: 'E', pool: '2', pp1: 90, pp2: 80 },
    ];
    const projections = Object.fromEntries(entries.map((e) => [e.manager, { mean: 50, variance: 100 }]));
    const { managers } = simulatePlayoffOdds({
      entries,
      projections,
      bracketSize: 3,
      sims: 3000,
      rng: makeLcg(5),
    });
    assert.ok(managers.C.wildcard > 0.99, `wildcard ${managers.C.wildcard}`);
    assert.ok(managers.C.winPP2Pool < 0.01);
    assert.ok(managers.C.make > 0.99);
    assert.ok(managers.D.make < 0.01);
  });

  it('is deterministic for a fixed rng seed', () => {
    const run = () =>
      simulatePlayoffOdds({
        entries: sixManagerEntries(),
        projections: { A3: { mean: 300, variance: 10000 } },
        bracketSize: 5,
        sims: 1000,
        rng: makeLcg(9),
      });
    assert.deepEqual(run(), run());
  });
});

describe('formatOddsPct', () => {
  it('formats the display range with locked/extreme handling', () => {
    assert.equal(formatOddsPct(1, true), '100%');
    assert.equal(formatOddsPct(0.9999, false), '>99%');
    assert.equal(formatOddsPct(0.622, false), '62%');
    assert.equal(formatOddsPct(0.0001, false), '<1%');
    assert.equal(formatOddsPct(0, false), '0%');
  });
});
