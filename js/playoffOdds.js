// ============================================================
// WMMC — Playoff-odds engine (pure)
// ============================================================
// Monte-Carlo odds for the stretch run of a round. The engine simulates every
// manager's remaining production (per-player per-game scoring rates x that
// player's team's remaining MLB games x how often he actually plays in one)
// and then asks the question the round is actually about:
//
//   * Pool play (PP2 Weeks 4-5) — apply the league's exact qualification
//     rules to each simulated season (win your pool's PP1 or PP2 period, or
//     take a wildcard on combined total) and report the fraction of
//     simulations in which each manager makes the 8-team bracket.
//   * A bracket round's final week (QF/SF/Finals Week 2) — play each
//     head-to-head matchup out and report the fraction of simulations each
//     side wins it. Same projections, same schedule-context adjustments; the
//     only difference is what counts as success.
//
// Everything here is pure and unit-tested (tests/playoffOdds.test.js).
// NOTE: a synced copy of these functions lives in server.js (the only
// runtime caller — it feeds the 4am compute, the Slack scoreboard, and the
// stored `sd.playoff_odds`). Keep both in sync, like SCORING/SEASON_SCHEDULE
// and detectScoreSwings.

import { SEASON_SCHEDULE } from './scoring.js';

// The odds are computed and displayed only during this slice of the season:
// PP2 Week 4 through the end of PP2 Week 5 (the last two pool-play weeks).
export const ODDS_WINDOW = { round: 'PP2', firstWeek: 'Week 4', lastWeek: 'Week 5' };

// Default number of Monte-Carlo iterations. 11 managers x 10k sims is
// well under a millisecond of arithmetic; the precision (~±0.5%) is far
// tighter than the projection inputs deserve.
export const ODDS_DEFAULT_SIMS = 10000;

// Returns the active odds window for `todayISO` (YYYY-MM-DD), or null when
// today falls outside PP2 Week 4–5 (or the schedule isn't configured).
// `start`/`end` bound the whole window; `remainingEnd` (= end) is the last
// scoring day the projections must cover.
export function oddsWindowForDate(scheduleDates, todayISO, schedule = SEASON_SCHEDULE) {
  if (!Array.isArray(scheduleDates) || !todayISO) return null;
  const idxOf = (round, week) => schedule.findIndex((s) => s.round === round && s.week === week);
  const firstIdx = idxOf(ODDS_WINDOW.round, ODDS_WINDOW.firstWeek);
  const lastIdx = idxOf(ODDS_WINDOW.round, ODDS_WINDOW.lastWeek);
  if (firstIdx === -1 || lastIdx === -1) return null;
  const first = scheduleDates[firstIdx] || {};
  const last = scheduleDates[lastIdx] || {};
  if (!first.start || !last.end) return null;
  if (todayISO < first.start || todayISO > last.end) return null;
  return {
    round: ODDS_WINDOW.round,
    week: first.end && todayISO <= first.end ? ODDS_WINDOW.firstWeek : ODDS_WINDOW.lastWeek,
    start: first.start,
    end: last.end,
  };
}

// The bracket rounds that get head-to-head odds in their FINAL week. Pool play
// keeps its own two-week window above; these get one, because a playoff round
// is only two weeks long to begin with.
export const BRACKET_ODDS_ROUNDS = ['QF', 'SF', 'Finals'];

// Returns the active bracket-odds window for `todayISO`, or null when today is
// not inside the last scheduled week of a QF/SF/Finals round. "Last week" is
// read off the schedule itself (the last entry carrying that round) rather than
// hardcoded to 'Week 2', so adding a third week to a round moves the window
// with it instead of silently pointing at the wrong one.
export function bracketOddsWindowForDate(scheduleDates, todayISO, schedule = SEASON_SCHEDULE) {
  if (!Array.isArray(scheduleDates) || !todayISO) return null;
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    if (!BRACKET_ODDS_ROUNDS.includes(entry.round)) continue;
    if (i + 1 < schedule.length && schedule[i + 1].round === entry.round) continue;
    const dates = scheduleDates[i] || {};
    if (!dates.start || !dates.end) continue;
    if (todayISO < dates.start || todayISO > dates.end) continue;
    return { round: entry.round, week: entry.week, start: dates.start, end: dates.end };
  }
  return null;
}

// Sample mean and (n-1) sample variance. Empty input -> zeros.
export function meanVariance(xs) {
  const arr = Array.isArray(xs) ? xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)) : [];
  const n = arr.length;
  if (n === 0) return { mean: 0, variance: 0, n: 0 };
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { mean, variance: 0, n };
  const variance = arr.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  return { mean, variance, n };
}

// Per-game scoring rate for one player, shrunk toward a league baseline so a
// player with 2 hot games doesn't project like prime Bonds. `k` is the
// shrinkage weight in pseudo-games: with n real games, the estimate is
// (n·sample + k·baseline) / (n + k). Variance blends the same way, except a
// 0/1-game sample contributes the baseline's variance (its own is unknowable).
export function playerGameRate(gameScores, baseline = { mean: 0, variance: 0 }, k = 5) {
  const { mean: sMean, variance: sVar, n } = meanVariance(gameScores);
  const bMean = baseline.mean || 0;
  const bVar = baseline.variance || 0;
  const mean = (sMean * n + bMean * k) / (n + k || 1);
  const ownVar = n >= 2 ? sVar : bVar;
  const variance = (ownVar * n + bVar * k) / (n + k || 1);
  return { mean, variance, games: n };
}

// ============================================================
// Appearance rate — "his team has 12 games left" is not "he has 12 games left"
// ============================================================
// A per-game scoring rate is a rate per APPEARANCE, so multiplying it by a
// team's remaining games projects a starting pitcher to take every turn and a
// platoon bat to start every day. `expectedAppearanceRate` is the correction:
// the player's own observed appearances over the same span, shrunk toward a
// positional prior by `k` pseudo-team-games so someone with almost no history
// (a call-up, a man back off the IL) lands on the prior instead of on 0 or 1.
//
// A starter taking every fifth turn sits near 0.2; an everyday bat near 0.9; a
// reliever in between. With no usable denominator — the team schedule fetch
// failed, so we don't know how many games the span even held — the prior is
// the honest answer, and a far better one than 1.0.
export const APPEARANCE_PRIORS = { batter: 0.85, pitcher: 0.3 };
export const APPEARANCE_RATE_FLOOR = 0.05;

export function expectedAppearanceRate(appearances, teamGamesInSpan, prior = APPEARANCE_PRIORS.batter, k = 8) {
  const played = typeof appearances === 'number' && appearances > 0 ? appearances : 0;
  const span = typeof teamGamesInSpan === 'number' && teamGamesInSpan > 0 ? teamGamesInSpan : 0;
  if (!span) return prior;
  const rate = (played + k * prior) / (span + k);
  return Math.min(1, Math.max(APPEARANCE_RATE_FLOOR, rate));
}

// ============================================================
// Schedule-context adjustments (opponent quality, home/away, park factor)
// ============================================================
// Layered on top of the base per-game rate from playerGameRate. Every factor
// is centered at 1.0 (neutral = no adjustment applied) and the combined
// per-game multiplier is clamped to a modest range so no combination of
// extremes (e.g. a weak-pitching opponent + hitter-friendly park + home) can
// dominate the simulation. This is a nudge in the direction real matchup
// context suggests, not a claim of precision.

// Generic MLB-wide home-field scoring edge (not team-specific) — modest and
// well-established historically (the long-run ~53-54% home win rate implies
// roughly a low-single-digit-percent scoring advantage). Applied the same
// direction to both batting and pitching (playing in front of your own
// bullpen/defense/crowd helps a pitcher's fantasy line too), unlike park
// factor, which cuts the other way for pitchers.
export const HOME_ADVANTAGE = 0.03; // home = x1.03, away = x0.97

// Team-abbreviation -> home-park run-scoring multiplier. Approximate
// MULTI-YEAR averages (not live/current-season), drawn from commonly-cited
// park factor estimates that public sources broadly agree on in direction
// and rough magnitude. Review and refresh at the start of each season — a
// stadium change, humidor adjustment, or relocation can move a park's factor
// meaningfully. ATH/OAK (Athletics, mid-relocation) and TB (Rays, playing at
// a temporary home after storm damage to Tropicana Field) are left neutral
// (1.0) rather than guessed — confirm their current-season home park and
// fill in a real number before trusting those two.
export const PARK_FACTORS = {
  ARI: 1.02,
  ATL: 1.01,
  ATH: 1.0,
  OAK: 1.0,
  BAL: 0.98,
  BOS: 1.04,
  CHC: 1.02,
  CWS: 1.0,
  CIN: 1.05,
  CLE: 0.97,
  COL: 1.15,
  DET: 0.97,
  HOU: 1.0,
  KC: 0.99,
  LAA: 0.98,
  LAD: 0.97,
  MIA: 0.95,
  MIL: 1.0,
  MIN: 0.99,
  NYM: 0.97,
  NYY: 1.02,
  PHI: 1.03,
  PIT: 0.97,
  SD: 0.93,
  SEA: 0.94,
  SF: 0.9,
  STL: 0.99,
  TB: 1.0,
  TEX: 1.02,
  TOR: 1.0,
  WSH: 0.98,
};

const PARK_FACTOR_CLAMP = [0.85, 1.15];
const OPPONENT_FACTOR_CLAMP = [0.85, 1.15];
const GAME_FACTOR_CLAMP = [0.7, 1.5];
const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

// Given raw team season stats, returns each team's quality relative to the
// league average across all teams with usable data. Any team missing/
// unparseable stats is simply excluded from the league average AND left out
// of the returned map (callers treat a missing entry as neutral).
//   pitchingRelative > 1  -> this team's OWN pitching is WORSE than average
//                            (higher ERA) -> good for a hitter facing them.
//   hittingRelative  > 1  -> this team's OWN offense is BETTER than average
//                            (more runs/game) -> tough for a pitcher facing them.
// teamStats: { [abbrev]: { era?, runsPerGame? } }
export function computeTeamQualityFactors(teamStats) {
  const eras = Object.values(teamStats || {})
    .map((t) => t.era)
    .filter((x) => typeof x === 'number' && x > 0);
  const rpgs = Object.values(teamStats || {})
    .map((t) => t.runsPerGame)
    .filter((x) => typeof x === 'number' && x > 0);
  const leagueEra = eras.length ? eras.reduce((a, b) => a + b, 0) / eras.length : null;
  const leagueRpg = rpgs.length ? rpgs.reduce((a, b) => a + b, 0) / rpgs.length : null;

  const out = {};
  for (const [abbrev, t] of Object.entries(teamStats || {})) {
    const pitchingRelative =
      leagueEra && typeof t.era === 'number' && t.era > 0 ? clamp(t.era / leagueEra, OPPONENT_FACTOR_CLAMP) : 1;
    const hittingRelative =
      leagueRpg && typeof t.runsPerGame === 'number' && t.runsPerGame > 0
        ? clamp(t.runsPerGame / leagueRpg, OPPONENT_FACTOR_CLAMP)
        : 1;
    out[abbrev] = { pitchingRelative, hittingRelative };
  }
  return out;
}

// The multiplier one specific remaining game contributes for one specific
// rostered player. `playerType` is 'batter' or 'pitcher'. `game` =
// { opponent, isHome, venueTeam } — venueTeam is whichever team is HOME in
// that game (that's whose park it's played at, regardless of which side the
// rostered player's own team is on). A missing opponent/venueTeam (unknown
// team abbreviation) simply falls back to neutral for that signal.
export function gameFactor(playerType, game, teamQuality = {}, parkFactors = PARK_FACTORS) {
  const opp = game && teamQuality[game.opponent];
  const opponentFactor = opp ? (playerType === 'batter' ? opp.pitchingRelative : 1 / opp.hittingRelative) : 1;
  const homeAwayFactor = game && game.isHome ? 1 + HOME_ADVANTAGE : 1 - HOME_ADVANTAGE;
  const rawPark = clamp((game && parkFactors[game.venueTeam]) ?? 1, PARK_FACTOR_CLAMP);
  const parkFactorApplied = playerType === 'batter' ? rawPark : 1 / rawPark;
  return clamp(opponentFactor * homeAwayFactor * parkFactorApplied, GAME_FACTOR_CLAMP);
}

// Aggregate per-player rates into one manager's remaining-production
// projection. Each entry: { mean, variance, gameFactors, appearanceRate }.
// `gameFactors` is one schedule-adjustment multiplier (see gameFactor) per
// remaining TEAM game — its LENGTH is the player's team's games remaining, not
// his own. `appearanceRate` (see expectedAppearanceRate; default 1) is the
// probability he actually plays in any one of them.
//
// Each remaining game therefore contributes B*f*S with B ~ Bernoulli(p) and S
// the per-appearance score, so by the law of total variance:
//   E[X]   = p * f * mean
//   Var[X] = f^2 * (p * variance + p(1-p) * mean^2)
// The second variance term is the appearance risk itself — for a pitcher who
// may get two starts or three, that IS most of the uncertainty, and dropping
// it is what makes a rotation look like a sure thing. p = 1 reduces the whole
// thing exactly to the previous behavior (mean * sum(f), variance * sum(f^2)),
// and `games` becomes EXPECTED appearances rather than team games.
export function projectManager(playerProjections) {
  let mean = 0;
  let variance = 0;
  let games = 0;
  for (const p of playerProjections || []) {
    const factors = Array.isArray(p.gameFactors) ? p.gameFactors : [];
    const rate = typeof p.appearanceRate === 'number' ? Math.min(1, Math.max(0, p.appearanceRate)) : 1;
    const sumFactors = factors.reduce((s, f) => s + f, 0);
    const sumFactorsSq = factors.reduce((s, f) => s + f * f, 0);
    const playerMean = p.mean || 0;
    mean += playerMean * rate * sumFactors;
    variance += (rate * (p.variance || 0) + rate * (1 - rate) * playerMean * playerMean) * sumFactorsSq;
    games += factors.length * rate;
  }
  return { mean, variance, games };
}

// Deterministic qualification snapshot from CURRENT scores — the same rules
// computePoolPlaySeeding applies: per pool the top PP1 and top PP2 scorer
// (score > 0) qualify; wildcards (highest combined total, > 0) fill the
// bracket to `bracketSize`; winners always seed above wildcards.
// Returns per-pool leaders plus the current qualifier list and cut line so
// callers can show "points back of the last wildcard". pp1LeaderByPool /
// pp2LeaderByPool name the pool alongside the leader, which is what the
// corrections-sweep Slack alert needs to say WHICH pool a winner flipped in.
export function currentQualification(entries, bracketSize = 8) {
  const pools = {};
  for (const e of entries) (pools[e.pool] = pools[e.pool] || []).push(e);

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();
  const pp1LeaderByPool = {};
  const pp2LeaderByPool = {};
  for (const [pool, members] of Object.entries(pools)) {
    let b1 = 0;
    let w1 = null;
    let b2 = 0;
    let w2 = null;
    for (const m of members) {
      if ((m.pp1 || 0) > b1) {
        b1 = m.pp1;
        w1 = m.manager;
      }
      if ((m.pp2 || 0) > b2) {
        b2 = m.pp2;
        w2 = m.manager;
      }
    }
    if (w1) {
      pp1Leaders.add(w1);
      pp1LeaderByPool[pool] = { manager: w1, pp1: b1 };
    }
    if (w2) {
      pp2Leaders.add(w2);
      pp2LeaderByPool[pool] = { manager: w2, pp2: b2 };
    }
  }

  const total = (e) => (e.pp1 || 0) + (e.pp2 || 0);
  const allLeaders = new Set([...pp1Leaders, ...pp2Leaders]);
  const winners = entries.filter((e) => allLeaders.has(e.manager)).sort((a, b) => total(b) - total(a));
  const wildcards = entries
    .filter((e) => !allLeaders.has(e.manager) && total(e) > 0)
    .sort((a, b) => total(b) - total(a))
    .slice(0, Math.max(0, bracketSize - winners.length));
  const qualifiers = [...winners, ...wildcards].slice(0, bracketSize);
  const cutTotal = qualifiers.length > 0 ? total(qualifiers[qualifiers.length - 1]) : 0;

  return {
    pp1Leaders,
    pp2Leaders,
    pp1LeaderByPool,
    pp2LeaderByPool,
    qualifierNames: qualifiers.map((e) => e.manager),
    cutTotal,
  };
}

// Box–Muller normal sampler driven by an injectable uniform rng, so the test
// suite can run the simulation deterministically.
export function makeNormalSampler(rng = Math.random) {
  return function normal() {
    let u = 0;
    let v = 0;
    // Guard against rng() returning exactly 0 (log(0) = -Infinity).
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// Monte-Carlo playoff odds.
//   entries:     [{ manager, pool, pp1, pp2 }] — CURRENT drop-aware totals.
//                PP1 is treated as final (the window opens after PP1 ends),
//                so its pool winners are banked qualifiers in every sim.
//   projections: { [manager]: { mean, variance } } — remaining PP2 production.
//   rng:         uniform [0,1) source (injectable for tests).
// Returns { sims, managers: { [name]: { make, winPP2Pool, wildcard, lockedPP1 } } }
// where make/winPP2Pool/wildcard are fractions of simulations (0..1).
export function simulatePlayoffOdds({
  entries,
  projections = {},
  bracketSize = 8,
  sims = ODDS_DEFAULT_SIMS,
  rng = Math.random,
}) {
  const normal = makeNormalSampler(rng);
  const names = entries.map((e) => e.manager);
  const pools = {};
  entries.forEach((e, i) => {
    (pools[e.pool] = pools[e.pool] || []).push(i);
  });

  // PP1 is complete in the odds window — its per-pool winners are fixed.
  const pp1WinnerIdx = new Set();
  for (const idxs of Object.values(pools)) {
    let best = 0;
    let winner = -1;
    for (const i of idxs) {
      if ((entries[i].pp1 || 0) > best) {
        best = entries[i].pp1;
        winner = i;
      }
    }
    if (winner >= 0) pp1WinnerIdx.add(winner);
  }

  const means = names.map((n) => (projections[n] && projections[n].mean) || 0);
  const sds = names.map((n) => Math.sqrt(Math.max(0, (projections[n] && projections[n].variance) || 0)));

  const counts = names.map(() => ({ make: 0, winPP2Pool: 0, wildcard: 0 }));
  const pp2Sim = new Array(names.length);
  const totalSim = new Array(names.length);

  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < names.length; i++) {
      const drawn = sds[i] > 0 ? means[i] + sds[i] * normal() : means[i];
      pp2Sim[i] = (entries[i].pp2 || 0) + drawn;
      totalSim[i] = (entries[i].pp1 || 0) + pp2Sim[i];
    }

    // Per-pool PP2 winner on simulated totals.
    const winnerIdx = new Set(pp1WinnerIdx);
    for (const idxs of Object.values(pools)) {
      let best = 0;
      let winner = -1;
      for (const i of idxs) {
        if (pp2Sim[i] > best) {
          best = pp2Sim[i];
          winner = i;
        }
      }
      if (winner >= 0) {
        winnerIdx.add(winner);
        counts[winner].winPP2Pool++;
      }
    }

    // Wildcards: highest combined totals among non-winners, filling to bracketSize.
    const wcSlots = Math.max(0, bracketSize - winnerIdx.size);
    const nonWinners = [];
    for (let i = 0; i < names.length; i++) {
      if (!winnerIdx.has(i) && totalSim[i] > 0) nonWinners.push(i);
    }
    nonWinners.sort((a, b) => totalSim[b] - totalSim[a]);
    const wildcardIdx = nonWinners.slice(0, wcSlots);

    // Winners seed first — when they exceed the bracket, lowest totals miss.
    let qualifiedIdx;
    if (winnerIdx.size > bracketSize) {
      qualifiedIdx = [...winnerIdx].sort((a, b) => totalSim[b] - totalSim[a]).slice(0, bracketSize);
    } else {
      qualifiedIdx = [...winnerIdx, ...wildcardIdx];
    }
    for (const i of qualifiedIdx) counts[i].make++;
    for (const i of wildcardIdx) counts[i].wildcard++;
  }

  const managers = {};
  names.forEach((n, i) => {
    managers[n] = {
      make: counts[i].make / sims,
      winPP2Pool: counts[i].winPP2Pool / sims,
      wildcard: counts[i].wildcard / sims,
      lockedPP1: pp1WinnerIdx.has(i),
    };
  });
  return { sims, managers };
}

// Monte-Carlo odds to WIN A HEAD-TO-HEAD MATCHUP — the bracket's version of
// the question simulatePlayoffOdds asks about pool play. Same projections and
// the same draw; the only difference is that success is beating one specific
// opponent instead of clearing a qualification bar.
//   pairs:       [{ label, a, b }] — the round's matchups (see computePlayoffPairs).
//   totals:      { [manager]: current round total } — drop-aware, as scored.
//   projections: { [manager]: { mean, variance } } — remaining production.
//   seedRank:    { [manager]: seed } — a simulated exact tie goes to the better
//                seed, which is the same rule the live bracket applies.
// Returns { sims, managers: { [name]: { advance } } } with advance a fraction
// (0..1). Every round pairs each manager exactly once today; should one ever
// appear in two matchups, the denominator counts both, so the number stays a
// fraction rather than climbing past 1.
export function simulateBracketOdds({
  pairs,
  totals = {},
  projections = {},
  seedRank = {},
  sims = ODDS_DEFAULT_SIMS,
  rng = Math.random,
}) {
  const normal = makeNormalSampler(rng);
  const matchups = (pairs || []).filter((p) => p && p.a && p.b);
  const counts = {};
  const played = {};
  for (const p of matchups) {
    for (const name of [p.a, p.b]) {
      if (!(name in counts)) counts[name] = 0;
      played[name] = (played[name] || 0) + 1;
    }
  }

  const draw = (name) => {
    const proj = projections[name] || {};
    const mean = proj.mean || 0;
    const sd = Math.sqrt(Math.max(0, proj.variance || 0));
    return (totals[name] || 0) + (sd > 0 ? mean + sd * normal() : mean);
  };

  for (let s = 0; s < sims; s++) {
    for (const p of matchups) {
      const aScore = draw(p.a);
      const bScore = draw(p.b);
      let winner;
      if (aScore !== bScore) winner = aScore > bScore ? p.a : p.b;
      else winner = (seedRank[p.a] ?? Infinity) <= (seedRank[p.b] ?? Infinity) ? p.a : p.b;
      counts[winner]++;
    }
  }

  const managers = {};
  for (const name of Object.keys(counts)) {
    const denom = sims * (played[name] || 1);
    managers[name] = { advance: denom > 0 ? counts[name] / denom : 0 };
  }
  return { sims, managers };
}

// Display helper shared by the scoreboard pill and the Slack section: a
// simulated 100%/0% is still an estimate unless the spot is mathematically
// banked (locked PP1 pool winner), so cap the displayed range.
export function formatOddsPct(fraction, locked = false) {
  if (locked) return '100%';
  const pct = fraction * 100;
  if (pct >= 99.5) return '>99%';
  if (pct > 0 && pct < 0.5) return '<1%';
  return `${Math.round(pct)}%`;
}
