// ============================================================
// WMMC — Playoff finishing status (pure)
// ============================================================
// Turns a season's bracket state into a per-manager finishing status, so the Hall
// of Fame can show an in-progress season the same way it shows a finished one:
// every manager placed at the round they went out in, with the managers still
// alive carrying the round they're currently playing as a temporary status.
//
// The ladder, as each round is finalized:
//   pool play ends  → the 4 non-qualifiers settle at "Did Not Qualify" (9th-12th),
//                     all 8 qualifiers show a live "Quarterfinals"
//   QF ends         → the 4 losers settle at "Quarterfinals" (5th-8th),
//                     the 4 winners flip to a live "Semifinals"
//   SF ends         → the 2 SF losers flip to a live "Consolation" (3rd-place game),
//                     the 2 winners flip to a live "Finals"
//   Finals ends     → 1st-4th resolve; nothing is live any more
//
// The status vocabulary is deliberately the same one the finished-season rows
// already use (Finals / Consolation / Quarterfinals / Did Not Qualify), so a
// season reads identically before and after it's in the books — the only
// difference is the `live` flag on managers who haven't been eliminated yet.
//
// PURE by design: it never touches season data, rosters or roster windows. The
// caller resolves who qualified, who advanced and what each manager scored in a
// round (in app.js, via the same getSeeding / getSFParticipants /
// getFinalsParticipants / roundBreakdown helpers the Playoff Bracket card uses),
// so this module can never disagree with the bracket about a result.

export const PLAYOFF_STATUS_LABELS = {
  pool: 'Pool Play',
  dnq: 'Did Not Qualify',
  quarterfinals: 'Quarterfinals',
  semifinals: 'Semifinals',
  consolation: 'Consolation',
  finals: 'Finals',
};

// Human-readable label for a status key (unknown keys pass through).
export function playoffStatusLabel(statusKey) {
  return PLAYOFF_STATUS_LABELS[statusKey] || statusKey || '';
}

// The status key a FINAL finishing position corresponds to, matching how the
// finished-season standings have always been labelled.
export function statusKeyForPosition(pos, fieldSize = 8) {
  if (pos <= 2) return 'finals';
  if (pos <= 4) return 'consolation';
  if (pos <= fieldSize) return 'quarterfinals';
  return 'dnq';
}

// Compute every manager's finishing status for a season, at whatever point it's reached.
//
//   managers           — canonical manager names (db.managers; the ONLY manager source)
//   qualifiers         — playoff field in seed order (index 0 = #1 seed); [] before seeding
//   sfParticipants     — QF winners, or null while QF is unfinalized
//   finalsParticipants — SF winners, or null while SF is unfinalized
//   finalized          — finalized round keys ('PP' | 'QF' | 'SF' | 'Finals')
//   ppTotals           — { manager: pool-play total }, orders the non-qualifiers
//   roundTotals        — { QF|SF|Finals: { manager: round total } }, orders the eliminated
//                        and decides the Finals/3rd-place games
//
// Returns { entries, standings, currentRound, complete, champion, runnerUp, third }:
//   entries    — [{ name, seed, statusKey, status, position, live }], live managers first
//                (by seed), then the eliminated in finishing order
//   standings  — { manager: position } for the positions that are settled
//   complete   — true once Finals is finalized and every position is known
function totalsFor(roundTotals, round) {
  return (roundTotals && roundTotals[round]) || {};
}

export function computePlayoffStatuses({
  managers = [],
  qualifiers = null,
  sfParticipants = null,
  finalsParticipants = null,
  finalized = [],
  ppTotals = {},
  roundTotals = {},
} = {}) {
  const fin = new Set(finalized || []);
  const names = (managers || []).filter(Boolean);
  const field = (qualifiers || []).filter((n) => names.includes(n));
  const seedRank = {};
  field.forEach((n, i) => (seedRank[n] = i + 1));

  const byName = new Map();
  const set = (name, statusKey, { position = null, live = false } = {}) => {
    if (!name || !names.includes(name)) return;
    byName.set(name, {
      name,
      seed: seedRank[name] || null,
      statusKey,
      status: playoffStatusLabel(statusKey),
      position,
      live,
    });
  };

  // Higher round total wins; a tie goes to the better seed — the same rule the bracket
  // uses (seeding already encodes the pool-play tiebreaker hierarchy).
  const beats = (a, b, round) => {
    const t = totalsFor(roundTotals, round);
    const ta = t[a] || 0;
    const tb = t[b] || 0;
    if (ta !== tb) return ta > tb;
    return (seedRank[a] || Infinity) <= (seedRank[b] || Infinity);
  };
  // Eliminated managers rank by their last round's score, best score = best position.
  const byRoundScore = (round) => (a, b) => {
    const t = totalsFor(roundTotals, round);
    return (t[b] || 0) - (t[a] || 0) || (seedRank[a] || Infinity) - (seedRank[b] || Infinity) || a.localeCompare(b);
  };

  const finish = (currentRound) => {
    const entries = [...byName.values()].sort(
      (a, b) =>
        Number(b.live) - Number(a.live) ||
        (a.live
          ? (a.seed || Infinity) - (b.seed || Infinity) || a.name.localeCompare(b.name)
          : (a.position || Infinity) - (b.position || Infinity) || a.name.localeCompare(b.name))
    );
    const standings = {};
    entries.forEach((e) => {
      if (e.position != null) standings[e.name] = e.position;
    });
    const at = (pos) => (entries.find((e) => e.position === pos) || {}).name || null;
    const complete = entries.length > 0 && entries.every((e) => e.position != null);
    return {
      entries,
      standings,
      currentRound,
      complete,
      champion: complete ? at(1) : null,
      runnerUp: complete ? at(2) : null,
      third: complete ? at(3) : null,
    };
  };

  // Before the field is set, everyone is simply still in pool play.
  if (field.length < 2 || !fin.has('PP')) {
    names.forEach((n) => set(n, 'pool', { live: true }));
    return finish('PP');
  }

  // Non-qualifiers settle below the field, ordered by pool-play total.
  names
    .filter((n) => !field.includes(n))
    .sort((a, b) => (ppTotals[b] || 0) - (ppTotals[a] || 0) || a.localeCompare(b))
    .forEach((n, i) => set(n, 'dnq', { position: field.length + 1 + i }));

  if (!fin.has('QF')) {
    field.forEach((n) => set(n, 'quarterfinals', { live: true }));
    return finish('QF');
  }

  const sf = (sfParticipants || []).filter((n) => field.includes(n));
  if (sf.length < 2) {
    // QF is flagged final but its winners aren't resolvable — leave the field live
    // rather than inventing eliminations.
    field.forEach((n) => set(n, 'quarterfinals', { live: true }));
    return finish('QF');
  }

  field
    .filter((n) => !sf.includes(n))
    .sort(byRoundScore('QF'))
    .forEach((n, i) => set(n, 'quarterfinals', { position: sf.length + 1 + i }));

  if (!fin.has('SF')) {
    sf.forEach((n) => set(n, 'semifinals', { live: true }));
    return finish('SF');
  }

  const finalsPair = (finalsParticipants || []).filter((n) => sf.includes(n));
  if (finalsPair.length < 2) {
    sf.forEach((n) => set(n, 'semifinals', { live: true }));
    return finish('SF');
  }
  const sfLosers = sf.filter((n) => !finalsPair.includes(n));

  if (!fin.has('Finals')) {
    finalsPair.forEach((n) => set(n, 'finals', { live: true }));
    sfLosers.forEach((n) => set(n, 'consolation', { live: true }));
    return finish('Finals');
  }

  // Finals round is in the books: the championship and the 3rd-place game are both
  // decided on the Finals-round totals (they're played concurrently).
  const champion = beats(finalsPair[0], finalsPair[1], 'Finals') ? finalsPair[0] : finalsPair[1];
  set(champion, 'finals', { position: 1 });
  set(
    finalsPair.find((n) => n !== champion),
    'finals',
    { position: 2 }
  );
  if (sfLosers.length === 2) {
    const third = beats(sfLosers[0], sfLosers[1], 'Finals') ? sfLosers[0] : sfLosers[1];
    set(third, 'consolation', { position: 3 });
    set(
      sfLosers.find((n) => n !== third),
      'consolation',
      { position: 4 }
    );
  } else {
    sfLosers.forEach((n, i) => set(n, 'consolation', { position: 3 + i }));
  }

  return finish(null);
}
