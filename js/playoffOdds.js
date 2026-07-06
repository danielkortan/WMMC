// ============================================================
// WMMC — Playoff-odds engine (pure)
// ============================================================
// Monte-Carlo playoff odds for the final stretch of pool play. The engine
// simulates every manager's remaining PP2 production (per-player per-game
// scoring rates x that player's team's remaining MLB games), applies the
// league's exact qualification rules to each simulated season — win your
// pool's PP1 or PP2 period, or take a wildcard on combined total — and
// reports the fraction of simulations in which each manager makes the
// 8-team bracket.
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

// Aggregate per-player rates into one manager's remaining-production
// projection. Assumes player game scores are independent, so means and
// variances both add across (player x remaining game).
export function projectManager(playerProjections) {
  let mean = 0;
  let variance = 0;
  let games = 0;
  for (const p of playerProjections || []) {
    const g = Math.max(0, p.gamesRemaining || 0);
    mean += (p.mean || 0) * g;
    variance += (p.variance || 0) * g;
    games += g;
  }
  return { mean, variance, games };
}

// Deterministic qualification snapshot from CURRENT scores — the same rules
// computePoolPlaySeeding applies: per pool the top PP1 and top PP2 scorer
// (score > 0) qualify; wildcards (highest combined total, > 0) fill the
// bracket to `bracketSize`; winners always seed above wildcards.
// Returns per-pool leaders plus the current qualifier list and cut line so
// callers can show "points back of the last wildcard".
export function currentQualification(entries, bracketSize = 8) {
  const pools = {};
  for (const e of entries) (pools[e.pool] = pools[e.pool] || []).push(e);

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();
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
    if (w1) pp1Leaders.add(w1);
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
