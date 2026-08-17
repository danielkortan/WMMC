// ============================================================
// WMMC — Next-round preview (pure)
// ============================================================
// The forward-looking half of a round-end Slack post: who is playing next, what form they
// are in, and who the numbers like. It exists because the Semifinals round-end post has
// nothing else to say — losing a semifinal eliminates nobody (the two losers play the
// 3rd-place game over the Finals weeks), so where the Quarterfinals post has a Hall of
// Shame, the Semifinals post has two upcoming games to sell.
//
// PURE by design, on the same terms as js/playoffCommentary.js: it is handed already-derived
// facts — the pairings, the points, the top performers, the career history — and only shapes
// them into text. It never reads season data, rosters or roster windows, so it can never
// disagree with the scoreboard about a score.
//
// The one editorial rule worth stating: the "edge" line is FORM, not a forecast, and it says
// so. Every playoff round opens a new submission period and rosters do not carry across one
// (the core scoring invariant), so points scored in the semifinal are evidence about the
// manager, not about the roster that is about to play. Overstating that would put a confident
// number next to a game whose lineups do not exist yet.

// A score as the rest of the Slack posts format one: one decimal, thousands separators, and
// no trailing `.0` — so the same number never appears twice in a post wearing two faces.
export function fmtPreviewScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// "(1) Alice" when the seed is known, "Alice" when it isn't.
function previewSeeded(team) {
  return team.seed ? `(${team.seed}) ${team.name}` : team.name;
}

// "QF 610.2 · SF 594.3" — the per-round splits behind the playoff total, so a manager who
// peaked early reads differently from one who is getting hotter.
function previewSplitLine(team) {
  const parts = (team.roundPoints || [])
    .filter((r) => r && r.round)
    .map((r) => `${r.round} ${fmtPreviewScore(r.points)}`);
  return parts.length ? ` (${parts.join(' \u{00B7} ')})` : '';
}

// The two or three players who actually carried this manager through the bracket. Named with
// their points because "his best hitter" is worth nothing without the number attached.
function previewTopLine(team) {
  const top = (team.top || []).filter((p) => p && p.name).slice(0, 3);
  if (!top.length) return '';
  return ` \u{00B7} carried by ${top.map((p) => `${p.name} ${fmtPreviewScore(p.points)}`).join(', ')}`;
}

// 1 -> '1st', 2 -> '2nd', 3 -> '3rd', 11 -> '11th'.
function previewOrdinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const rem100 = v % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${v}th`;
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

const previewPlural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One manager's career, in the single most interesting sentence available about it — chosen
// by how much it raises the stakes of the game being previewed, most loaded first. Never
// invents a fact: a manager with no finished season on record is simply described as such.
//
// `history` is a js/history.js managerPlayoffHistory result. `label` is the matchup label, so
// a 3rd-place-game preview doesn't tell somebody he is chasing a Cup he has already lost.
export function previewHistoryFact(name, history, label = 'Championship') {
  if (!history || !history.seasonsPlayed) {
    return `${name} has no finished WMMC season on record — everything from here is a first.`;
  }
  const seasons = previewPlural(history.seasonsPlayed, 'season');

  if (history.titleCount > 0) {
    return history.titleCount === 1
      ? `${name} won it in ${history.lastTitle}.`
      : `${name} has ${previewPlural(history.titleCount, 'Cup')}, most recently ${history.lastTitle}.`;
  }
  if (history.neverMadeFinals && label === 'Championship') {
    return `${name} has never reached a Final in ${seasons} — this is the first.`;
  }
  if (history.finalsAppearances > 0) {
    return `${name} has ${previewPlural(history.finalsAppearances, 'Final')} and no Cup${
      history.lastYearInFinals ? `, the last in ${history.lastYearInFinals}` : ''
    }.`;
  }
  if (history.sfExitCount > 0) {
    return `${name} has lost ${previewPlural(history.sfExitCount, 'semifinal')}${
      history.lastYearInSemis ? `, the last in ${history.lastYearInSemis}` : ''
    }, and never got past one.`;
  }
  if (history.neverPastQF) {
    return `${name} had never won a playoff game before this year, across ${seasons}.`;
  }
  const best = history.seasons.reduce((lo, s) => (lo === null || s.place < lo.place ? s : lo), null);
  return best
    ? `${name}'s best finish is ${previewOrdinal(best.place)}, in ${best.year}.`
    : `${name} is ${seasons} into his WMMC career.`;
}

// Who the form likes, and by how much — stated as form and labelled as form. Returns '' when
// neither manager has any bracket scoring to compare, because a pick from nothing is a guess
// wearing a number.
export function previewEdge(a, b) {
  const pa = Number(a.playoffPoints) || 0;
  const pb = Number(b.playoffPoints) || 0;
  if (pa <= 0 && pb <= 0) return '';
  const gap = Math.round(Math.abs(pa - pb) * 10) / 10;
  if (gap < 1) {
    return `Dead level across the bracket — ${fmtPreviewScore(pa)} apiece. Fresh rosters decide this one entirely.`;
  }
  const leader = pa > pb ? a : b;
  // The gap against the bigger of the two totals, so "62 points" reads as the rounding error
  // or the chasm it actually is instead of as a bare number.
  const share = gap / Math.max(pa, pb);
  const strength =
    share >= 0.1
      ? 'and it has not been close'
      : share >= 0.03
        ? 'a real gap, but a survivable one'
        : 'which is close enough to nothing';
  return `Form likes ${leader.name} — ${fmtPreviewScore(gap)} more points across the bracket, ${strength}. Both rosters reset for these weeks, so treat it as form, not a forecast.`;
}

// One upcoming matchup, as a Slack mrkdwn section.
//
//   matchup — { label, emoji?, stakes?, teams: [team, team] }, each team
//             { name, seed?, playoffPoints, roundPoints: [{ round, points }], top: [{ name, points }],
//               history: managerPlayoffHistory result | null }
//
// `stakes` is the one line that says what the game is actually FOR, and it is not decoration.
// Both Finals-week games are previewed side by side, and without it the 3rd-place game reads
// like a second title race — when in truth both its managers are already out of the Cup and are
// playing for next season's draft position. Overselling that is the thing this section must not
// do. Omitted, no stakes line is printed.
//
// Returns '' unless both sides are known — a half-built preview is worse than none.
export function buildMatchupPreview(matchup) {
  const teams = ((matchup && matchup.teams) || []).filter((t) => t && t.name);
  if (teams.length !== 2) return '';
  const [a, b] = teams;
  const emoji = matchup.emoji || '\u{1F3C6}';
  const lines = [`${emoji} *${matchup.label}* — ${previewSeeded(a)} vs ${previewSeeded(b)}`];
  if (matchup.stakes) lines.push(`> ${matchup.stakes}`);
  for (const t of teams) {
    lines.push(
      `> *${t.name}* — ${fmtPreviewScore(t.playoffPoints)} pts in the bracket${previewSplitLine(t)}${previewTopLine(t)}`
    );
  }
  // Both trailing lines are labelled rather than wrapped whole in italics, and that is load
  // bearing: Slack's italic marker is `_`, `_` is a word character, and the shortening pass that
  // rewrites full manager names at the send boundary matches on `\b` — so a line that OPENS with
  // `_Alice Adams …` is the one place a manager's full name survives into a post while every
  // other mention of him is short. Keep a non-name word first.
  const facts = teams.map((t) => previewHistoryFact(t.name, t.history, matchup.label)).filter(Boolean);
  if (facts.length) lines.push(`> _History:_ ${facts.join(' ')}`);
  const edge = previewEdge(a, b);
  if (edge) lines.push(`> _Early edge:_ ${edge}`);
  return lines.join('\n');
}

// The whole preview section for a round-end post: a heading plus one block per upcoming
// matchup. Returns '' when nothing is previewable, so a caller can append it unconditionally.
export function buildRoundPreviewBlock({ heading = null, matchups = [] } = {}) {
  const blocks = (matchups || []).map(buildMatchupPreview).filter(Boolean);
  if (!blocks.length) return '';
  const head = heading || '\u{1F52E} *Up next*';
  return [head, ...blocks].join('\n\n');
}
