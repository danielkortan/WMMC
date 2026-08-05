// ============================================================
// WMMC — Playoff bracket structure
// ============================================================
// The shape of the tournament, as a pure function of the seeding plus a per-round score lookup.
// Extracted so the What If sandbox can re-run the bracket under a scenario using the SAME pairing
// and tie-break rules the real bracket uses (app.js playoffRoundMatchups / getSFParticipants /
// roundMatchupWinner), rather than a second interpretation of them.
//
// THE HONEST LIMIT, and why `score` may be null.
//
// Re-seeding is computable: seeds fall out of pool-play scoring, which we have for everyone. What
// happens AFTER that is not. A manager who was really eliminated in the quarterfinal never
// submitted a semifinal roster, so there is nothing to score them with — no amount of arithmetic
// invents those points.
//
// So this module reports what it knows and says so where it doesn't: a side with no roster for a
// round carries `score: null`, the matchup is left `undecided`, and nothing downstream advances.
// The Roster Lab is the way to fill that gap deliberately — a manager can enter the roster they
// would have played, at which point the score exists and the bracket resolves.

// QF pairings in bracket display order: 1v8, 4v5, 3v6, 2v7. The winners come back in this same
// order, and the semifinals pair them [0]v[1] and [2]v[3] — the standard bracket, matching
// getSFParticipants in app.js.
const QF_PAIRS = [
  [0, 7],
  [3, 4],
  [2, 5],
  [1, 6],
];

const QF_LABELS = ['QF1', 'QF4', 'QF3', 'QF2'];

// Better seed wins a tie, mirroring roundMatchupWinner.
function decide(a, b) {
  if (!a || !b) return null;
  if (a.score == null || b.score == null) return null;
  if (a.score !== b.score) return a.score > b.score ? a : b;
  return a.seed <= b.seed ? a : b;
}

function side(name, seed, score) {
  return { name, seed, score: score == null ? null : Math.round(score * 100) / 100 };
}

// Build the whole bracket.
//
// `qualifiers` is the seeded list of 8 manager names (index 0 = the 1 seed).
// `scoreFor(manager, round)` returns that manager's points for the round under the scenario, or
// null when they have no roster for it.
//
// Returns { rounds: [{ round, label, matchups: [...] }], champion, thirdPlace, complete }.
// Each matchup is { label, a, b, winner, loser, undecided }.
export function resolveBracket(qualifiers, scoreFor) {
  if (!Array.isArray(qualifiers) || qualifiers.length < 8) return null;
  const seeded = qualifiers.slice(0, 8);
  const seedOf = new Map(seeded.map((n, i) => [n, i + 1]));
  const mk = (name, round) => (name ? side(name, seedOf.get(name) || 99, scoreFor(name, round)) : null);

  const matchup = (label, a, b) => {
    const winner = decide(a, b);
    const loser = winner ? (winner === a ? b : a) : null;
    return { label, a, b, winner, loser, undecided: !winner };
  };

  const qf = QF_PAIRS.map(([i, j], idx) => matchup(QF_LABELS[idx], mk(seeded[i], 'QF'), mk(seeded[j], 'QF')));

  const rounds = [{ round: 'QF', label: 'Quarterfinals', matchups: qf }];

  // The semifinal only exists once both feeding quarterfinals have a winner.
  const qfWinners = qf.map((m) => (m.winner ? m.winner.name : null));
  const sf = [
    matchup('SF1', mk(qfWinners[0], 'SF'), mk(qfWinners[1], 'SF')),
    matchup('SF2', mk(qfWinners[2], 'SF'), mk(qfWinners[3], 'SF')),
  ];
  const sfKnown = qfWinners.every(Boolean);
  if (sfKnown) rounds.push({ round: 'SF', label: 'Semifinals', matchups: sf });

  let champion = null;
  let thirdPlace = null;
  if (sfKnown && !sf[0].undecided && !sf[1].undecided) {
    const final = matchup('Championship', mk(sf[0].winner.name, 'Finals'), mk(sf[1].winner.name, 'Finals'));
    const third = matchup('3rd Place', mk(sf[0].loser.name, 'Finals'), mk(sf[1].loser.name, 'Finals'));
    rounds.push({ round: 'Finals', label: 'Finals', matchups: [final, third] });
    champion = final.winner ? final.winner.name : null;
    thirdPlace = third.winner ? third.winner.name : null;
  }

  return {
    rounds,
    champion,
    thirdPlace,
    complete: !!champion,
    // Every side that has no roster for its round — what the UI points at when it explains why the
    // bracket stops where it does.
    missing: rounds.flatMap((r) =>
      r.matchups.flatMap((m) =>
        [m.a, m.b].filter((s) => s && s.score == null).map((s) => ({ manager: s.name, round: r.round }))
      )
    ),
  };
}
