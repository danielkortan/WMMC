// ============================================================
// WMMC — Pool play seeding
// ============================================================
// Who makes the playoffs, and in what order. Extracted from app.js's computePoolPlaySeeding so
// there is ONE implementation of the rule: the live bracket calls it with the season's real
// period totals, and the What If sandbox calls it with a scenario's totals. A second copy would
// let a hypothetical bracket disagree with the real one about the rules themselves, which is the
// one thing a "what if" must never do.
//
// The rule: each pool crowns a PP1 leader and a PP2 leader (one manager can be both). Those pool
// winners seed above everyone else; the remaining spots go to the highest-scoring non-winners as
// wildcards. Within each group, order is by total, then periods won, then batting, pitching, PP2,
// PP1.

const r2 = (x) => Math.round(x * 100) / 100;

// `entries` are { manager, pool, pp1Bat, pp1Pit, pp2Bat, pp2Pit }, already filtered to the
// managers eligible for seeding. Entry ORDER is significant: an exact tie for a pool's period
// lead is resolved in favor of whichever manager appears first, matching the original behavior.
export function seedFromPeriodTotals(entries, { bracketSize = 8 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const sc = {};
  const order = [];
  for (const e of entries) {
    if (!e || !e.manager) continue;
    sc[e.manager] = {
      manager: e.manager,
      pool: e.pool,
      pp1Bat: e.pp1Bat || 0,
      pp1Pit: e.pp1Pit || 0,
      pp2Bat: e.pp2Bat || 0,
      pp2Pit: e.pp2Pit || 0,
      isPP1Leader: false,
      isPP2Leader: false,
      isWildcard: false,
    };
    order.push(e.manager);
  }
  if (order.length === 0) return null;

  for (const s of Object.values(sc)) {
    s.pp1 = r2(s.pp1Bat + s.pp1Pit);
    s.pp2 = r2(s.pp2Bat + s.pp2Pit);
    s.batting = r2(s.pp1Bat + s.pp2Bat);
    s.pitching = r2(s.pp1Pit + s.pp2Pit);
    s.total = r2(s.batting + s.pitching);
  }

  const poolGroups = {};
  for (const name of order) {
    const pool = sc[name].pool;
    (poolGroups[pool] = poolGroups[pool] || []).push(name);
  }

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();
  for (const members of Object.values(poolGroups)) {
    let b1 = -Infinity;
    let w1 = null;
    let b2 = -Infinity;
    let w2 = null;
    for (const n of members) {
      const s = sc[n];
      if (!s) continue;
      if (s.pp1 > b1) {
        b1 = s.pp1;
        w1 = n;
      }
      if (s.pp2 > b2) {
        b2 = s.pp2;
        w2 = n;
      }
    }
    // A pool with no scoring yet has no leader — a zero-point "lead" is not a won period.
    if (w1 && b1 > 0) {
      pp1Leaders.add(w1);
      sc[w1].isPP1Leader = true;
    }
    if (w2 && b2 > 0) {
      pp2Leaders.add(w2);
      sc[w2].isPP2Leader = true;
    }
  }

  for (const s of Object.values(sc)) {
    s.periodsWon = (s.isPP1Leader ? 1 : 0) + (s.isPP2Leader ? 1 : 0);
    s.isPoolWinner = s.periodsWon > 0;
  }

  // Primary = total (desc); tiebreaker = periods won -> batting -> pitching -> PP2 -> PP1.
  const cmp = (a, b) =>
    b.total - a.total ||
    b.periodsWon - a.periodsWon ||
    b.batting - a.batting ||
    b.pitching - a.pitching ||
    b.pp2 - a.pp2 ||
    b.pp1 - a.pp1;

  const all = order.map((n) => sc[n]);
  const winners = all.filter((s) => s.isPoolWinner).sort(cmp);
  const wildcardsNeeded = Math.max(0, bracketSize - winners.length);
  const wildcards = all
    .filter((s) => !s.isPoolWinner && s.total > 0)
    .sort(cmp)
    .slice(0, wildcardsNeeded);
  for (const s of wildcards) s.isWildcard = true;

  // Winners always seeded above wildcards; each group ordered by total (+ tiebreak).
  const seeds = [...winners, ...wildcards].slice(0, bracketSize);
  seeds.forEach((s, i) => {
    s.seed = i + 1;
  });

  return {
    seeds,
    byManager: sc,
    pp1Leaders,
    pp2Leaders,
    allLeaders: new Set([...pp1Leaders, ...pp2Leaders]),
    wildcardSet: new Set(wildcards.map((s) => s.manager)),
    qualifierNames: seeds.map((s) => s.manager),
  };
}
