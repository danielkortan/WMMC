// ============================================================
// WMMC — Season Accolades (pure)
// ============================================================
// Season-long tallies computed from the daily stat rows (daily_batting /
// daily_pitching deltas): how often each manager finished in the daily top-3 /
// bottom-3, which pitchers posted negative days, which batters struck out 3+
// times in a day, and the single-day season records.
//
// The per-day semantics deliberately mirror the server's computeDailyHighLow
// (the "Yesterday's Best & Worst" Slack section):
//   - a player only counts on dates they actually played (some nonzero delta);
//   - doubleheader rows on the same date aggregate into one player-day;
//   - only rostered players count — attribution is delegated to the caller's
//     `resolveManager(row, type)` so this module stays pure (no roster/window
//     knowledge); return null/undefined to exclude a row;
//   - the daily top-N and bottom-N manager lists are disjoint: bottom-N is
//     drawn from the managers left after the top-N are removed, so a 4-manager
//     playoff day never counts the same manager as both best and worst.

import { calculateBattingScore, calculatePitchingScore } from './scoring.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Same "did this player actually play today" test the server uses.
const hadGame = (delta) => !!delta && Object.values(delta).some((v) => (parseFloat(v) || 0) !== 0);

// Compute the season accolade tallies.
//
//   dailyBatting / dailyPitching — raw daily rows ({ date, round, week,
//     batter|pitcher, delta, ... }).
//   resolveManager(row, type)    — returns the owning manager name for a row
//     (type is 'batting' | 'pitching'), or null to exclude it.
//   topN                         — daily best/worst list size (default 3).
//   minStrikeouts                — batter strikeout threshold (default 3).
//   recordsN                     — single-day record list size (default 5).
//
// Returns {
//   days,                       // number of dates with at least one game
//   managerBest:  [{ manager, count }],   // days finished in the daily top-N
//   managerWorst: [{ manager, count }],   // days finished in the daily bottom-N
//   pitcherNegativeDays: [{ player, manager, count, worst: { date, score } }],
//   batterHighKDays:     [{ player, manager, count, maxK, worst: { date, so } }],
//   records: {                  // single-day record lists, recordsN entries each
//     bestManagerDays:  [{ manager, date, total }],   // highest daily totals
//     worstManagerDays: [{ manager, date, total }],   // lowest daily totals
//     bestPlayerDays:   [{ player, type, manager, date, score, so }],
//     worstPlayerDays:  [{ player, type, manager, date, score, so }],
//   },
// }
export function computeSeasonAccolades({
  dailyBatting = [],
  dailyPitching = [],
  resolveManager = () => null,
  topN = 3,
  minStrikeouts = 3,
  recordsN = 5,
} = {}) {
  // ---- Aggregate rows into per-date player-days (doubleheaders merge) ----
  // byDate[date] = { batters: { name: { score, so, manager } },
  //                  pitchers: { name: { score, manager } } }
  const byDate = {};
  const dateBucket = (date) => (byDate[date] = byDate[date] || { batters: {}, pitchers: {} });

  for (const row of dailyBatting) {
    if (!row || !row.date || !hadGame(row.delta)) continue;
    const manager = resolveManager(row, 'batting');
    if (!manager) continue;
    const bucket = dateBucket(row.date).batters;
    const entry = bucket[row.batter] || (bucket[row.batter] = { score: 0, so: 0, manager });
    entry.score += calculateBattingScore(row.delta);
    entry.so += parseFloat(row.delta.so) || 0;
  }

  for (const row of dailyPitching) {
    if (!row || !row.date || !hadGame(row.delta)) continue;
    const manager = resolveManager(row, 'pitching');
    if (!manager) continue;
    const bucket = dateBucket(row.date).pitchers;
    const entry = bucket[row.pitcher] || (bucket[row.pitcher] = { score: 0, manager });
    entry.score += calculatePitchingScore(row.delta);
  }

  // ---- Walk the dates, tallying accolades ----
  const bestCounts = {};
  const worstCounts = {};
  const negativePitchers = {}; // name -> { manager, count, worst: {date, score} }
  const highKBatters = {}; // name -> { manager, count, maxK, worst: {date, so} }
  const managerDays = []; // every (manager, date) daily total, for the record lists
  const playerDays = []; // every (player, date) daily score, for the record lists

  const dates = Object.keys(byDate).sort();
  for (const date of dates) {
    const { batters, pitchers } = byDate[date];
    const managerTotals = {};

    for (const [name, e] of Object.entries(batters)) {
      const score = round2(e.score);
      managerTotals[e.manager] = (managerTotals[e.manager] || 0) + score;
      if (e.so >= minStrikeouts) {
        const rec = (highKBatters[name] = highKBatters[name] || {
          manager: e.manager,
          count: 0,
          maxK: 0,
          worst: null,
        });
        rec.count++;
        rec.manager = e.manager; // keep the most recent owner
        if (e.so > rec.maxK) {
          rec.maxK = e.so;
          rec.worst = { date, so: e.so };
        }
      }
      playerDays.push({ player: name, type: 'Batter', manager: e.manager, date, score, so: e.so });
    }

    for (const [name, e] of Object.entries(pitchers)) {
      const score = round2(e.score);
      managerTotals[e.manager] = (managerTotals[e.manager] || 0) + score;
      if (score < 0) {
        const rec = (negativePitchers[name] = negativePitchers[name] || {
          manager: e.manager,
          count: 0,
          worst: null,
        });
        rec.count++;
        rec.manager = e.manager;
        if (!rec.worst || score < rec.worst.score) rec.worst = { date, score };
      }
      playerDays.push({ player: name, type: 'Pitcher', manager: e.manager, date, score, so: 0 });
    }

    const ranked = Object.entries(managerTotals)
      .map(([manager, total]) => ({ manager, total: round2(total) }))
      .sort((a, b) => b.total - a.total);
    if (ranked.length === 0) continue;

    // Disjoint top/bottom, exactly like the server's daily Slack section.
    const topCount = Math.min(topN, ranked.length);
    const top = ranked.slice(0, topCount);
    const remaining = ranked.slice(topCount);
    const bottom = remaining.slice(-Math.min(topN, remaining.length));

    for (const { manager } of top) bestCounts[manager] = (bestCounts[manager] || 0) + 1;
    for (const { manager } of bottom) worstCounts[manager] = (worstCounts[manager] || 0) + 1;

    for (const { manager, total } of ranked) managerDays.push({ manager, date, total });
  }

  const toCounts = (counts) =>
    Object.entries(counts)
      .map(([manager, count]) => ({ manager, count }))
      .sort((a, b) => b.count - a.count || a.manager.localeCompare(b.manager));

  const pitcherNegativeDays = Object.entries(negativePitchers)
    .map(([player, r]) => ({ player, manager: r.manager, count: r.count, worst: r.worst }))
    .sort((a, b) => b.count - a.count || a.worst.score - b.worst.score || a.player.localeCompare(b.player));

  const batterHighKDays = Object.entries(highKBatters)
    .map(([player, r]) => ({ player, manager: r.manager, count: r.count, maxK: r.maxK, worst: r.worst }))
    .sort((a, b) => b.count - a.count || b.maxK - a.maxK || a.player.localeCompare(b.player));

  // Single-day record lists. Best/worst manager and player days rank by the
  // day's points; worst player days tiebreak on batter strikeouts (mirroring
  // the server's worstPlayerOverall — among equally pointless days, more Ks is
  // the worse one; pitchers go negative and sort to the top on score alone).
  const byTotalDesc = (a, b) => b.total - a.total || a.date.localeCompare(b.date);
  const byTotalAsc = (a, b) => a.total - b.total || a.date.localeCompare(b.date);
  const byScoreDesc = (a, b) => b.score - a.score || a.date.localeCompare(b.date);
  const byScoreAsc = (a, b) => a.score - b.score || (b.so || 0) - (a.so || 0) || a.date.localeCompare(b.date);
  const records = {
    bestManagerDays: [...managerDays].sort(byTotalDesc).slice(0, recordsN),
    worstManagerDays: [...managerDays].sort(byTotalAsc).slice(0, recordsN),
    bestPlayerDays: [...playerDays].sort(byScoreDesc).slice(0, recordsN),
    worstPlayerDays: [...playerDays].sort(byScoreAsc).slice(0, recordsN),
  };

  return {
    days: dates.length,
    managerBest: toCounts(bestCounts),
    managerWorst: toCounts(worstCounts),
    pitcherNegativeDays,
    batterHighKDays,
    records,
  };
}
