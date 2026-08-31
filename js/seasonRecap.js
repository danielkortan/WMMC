// ============================================================
// WMMC — Season recap (pure)
// ============================================================
// The last Slack post of the year. It goes out when the commissioner closes the season:
// the podium with the scores that decided it, every manager's final placing, the season's
// superlatives, a career line for each podium finisher, and a written wrap.
//
// PURE by design, on the same terms as js/roundPreview.js and js/playoffCommentary.js: it is
// handed already-derived facts — placements, totals, player lines, career history — and only
// shapes them into text. It never reads season data, rosters or roster windows, so it can
// never disagree with the scoreboard about a score. The fact-gathering that feeds it
// (collectSeasonRecapFacts) is server-only glue, because that is the half that has to respect
// the roster windows.
//
// Emoji are written as literal Unicode rather than Slack shortcodes, the same way
// js/roundPreview.js writes them. Shortcodes are an external contract with no local validator
// — an unknown one prints as literal `:text:` in the channel, which is how `:tickets:` once
// shipped to the league — and a recap posts exactly once a year, with no second chance to
// notice. A literal codepoint cannot be unknown.

const TROPHY = '\u{1F3C6}'; // trophy
const SILVER = '\u{1F948}'; // 2nd place medal
const BRONZE = '\u{1F949}'; // 3rd place medal
const BASEBALL = '\u{26BE}'; // baseball
const CHART = '\u{1F4CA}'; // bar chart
const CLIPBOARD = '\u{1F4CB}'; // clipboard
const LINK = '\u{1F517}'; // link
const MICROPHONE = '\u{1F3A4}'; // microphone

// A score as every other Slack post formats one: one decimal, thousands separators, and no
// trailing `.0` — so the same number never appears twice in a post wearing two faces.
export function fmtRecapScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// 1 -> '1st', 2 -> '2nd', 3 -> '3rd', 11 -> '11th'.
export function recapOrdinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const rem100 = v % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${v}th`;
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// A stable index into a bank, derived from the text handed in. The recap is generated at most
// once a season but MAY be re-run (the commissioner's "Re-run Season Close" button), and a
// re-run that silently reshuffles which fallback line was used reads as a different season
// rather than the same one posted twice.
function recapSeed(key) {
  let seed = 0;
  for (const c of String(key || '')) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  return seed;
}

// "1,204.5-1,180.2 (by 24.3)" — the result line under a podium name, always from THAT
// manager's side. Written from the winner's side for everyone it produced a line reading
// "lost the Championship 1,204.5-1,180.2", which says the loser scored the winning total.
// Returns '' when the game isn't resolvable, so the name still renders on its own.
function gameLine(game, forManager) {
  if (!game || !game.winner || !game.loser) return '';
  const lost = forManager === game.loser;
  const mine = lost ? game.loserScore : game.winnerScore;
  const theirs = lost ? game.winnerScore : game.loserScore;
  return `${fmtRecapScore(mine)}\u{2013}${fmtRecapScore(theirs)} (by ${fmtRecapScore(game.margin)})`;
}

// The podium: the four managers who played the Finals weeks, with the two games that sorted
// them. Champion and runner-up came out of the Championship, 3rd and 4th out of the 3rd-place
// game — both played over the SAME two weeks, which is why all four are here and not two.
export function buildPodiumBlock(facts) {
  const f = facts || {};
  if (!f.champion) return '';
  const lines = [`${TROPHY} *The ${f.year} Whit Merrifield Memorial Cup goes to ${f.champion}.*`];

  const champWon = gameLine(f.championship, f.champion);
  lines.push(`${TROPHY} *1st \u{2014} ${f.champion}*${champWon ? ` \u{2014} won the Championship ${champWon}` : ''}`);
  if (f.runnerUp) {
    const champLost = gameLine(f.championship, f.runnerUp);
    lines.push(
      `${SILVER} *2nd \u{2014} ${f.runnerUp}*${champLost ? ` \u{2014} lost the Championship ${champLost}` : ''}`
    );
  }
  if (f.third) {
    const thirdWon = gameLine(f.thirdPlaceGame, f.third);
    lines.push(`${BRONZE} *3rd \u{2014} ${f.third}*${thirdWon ? ` \u{2014} won the 3rd-place game ${thirdWon}` : ''}`);
  }
  if (f.fourth) {
    const thirdLost = gameLine(f.thirdPlaceGame, f.fourth);
    lines.push(`*4th \u{2014} ${f.fourth}*${thirdLost ? ` \u{2014} lost the 3rd-place game ${thirdLost}` : ''}`);
  }
  return lines.join('\n');
}

// Every manager, in final order, with where they went out and what they scored getting there.
//
// `standings` is already ordered and already carries its `place` — the ordering rule (podium
// from the bracket, then quarterfinal losers by playoff points, then everyone else by pool
// play) is a fact about the season, so it is settled by the caller and not re-litigated here.
export function buildFinalStandingsBlock(standings) {
  const rows = (standings || []).filter((s) => s && s.manager);
  if (!rows.length) return '';
  const lines = rows.map((s) => {
    const exit = s.exit ? ` \u{2014} ${s.exit}` : '';
    const pts = Number.isFinite(Number(s.seasonPoints)) ? ` \u{00B7} ${fmtRecapScore(s.seasonPoints)} pts` : '';
    return `${recapOrdinal(s.place)}. *${s.manager}*${exit}${pts}`;
  });
  return [`${CLIPBOARD} *Final standings*`, ...lines].join('\n');
}

// The season's outliers. Every entry is optional: a season missing daily rows, or one where
// nobody ever swapped, just gets a shorter block. Returns '' when nothing survived, so the
// caller can append it unconditionally.
export function buildSuperlativesBlock(superlatives) {
  const s = superlatives || {};
  const lines = [];
  if (s.seasonPoints && s.seasonPoints.manager) {
    lines.push(
      `\u{2022} *Most points all season:* ${s.seasonPoints.manager} \u{2014} ${fmtRecapScore(s.seasonPoints.points)}`
    );
  }
  if (s.poolPlayLeader && s.poolPlayLeader.manager) {
    lines.push(
      `\u{2022} *Pool play winner:* ${s.poolPlayLeader.manager} \u{2014} ${fmtRecapScore(s.poolPlayLeader.points)}`
    );
  }
  if (s.bestWeek && s.bestWeek.manager) {
    lines.push(
      `\u{2022} *Best single week:* ${s.bestWeek.manager} \u{2014} ${fmtRecapScore(s.bestWeek.points)} in ${s.bestWeek.label}`
    );
  }
  if (s.topBatter && s.topBatter.name) {
    lines.push(
      `\u{2022} *Top bat:* ${s.topBatter.name} \u{2014} ${fmtRecapScore(s.topBatter.points)} for ${s.topBatter.manager}`
    );
  }
  if (s.topPitcher && s.topPitcher.name) {
    lines.push(
      `\u{2022} *Top arm:* ${s.topPitcher.name} \u{2014} ${fmtRecapScore(s.topPitcher.points)} for ${s.topPitcher.manager}`
    );
  }
  if (s.biggestBlowout && s.biggestBlowout.winner) {
    lines.push(
      `\u{2022} *Biggest beating:* ${s.biggestBlowout.winner} over ${s.biggestBlowout.loser} by ${fmtRecapScore(s.biggestBlowout.margin)} (${s.biggestBlowout.label})`
    );
  }
  if (s.closestGame && s.closestGame.winner) {
    lines.push(
      `\u{2022} *Closest game:* ${s.closestGame.winner} over ${s.closestGame.loser} by ${fmtRecapScore(s.closestGame.margin)} (${s.closestGame.label})`
    );
  }
  if (s.mostSwaps && s.mostSwaps.manager) {
    lines.push(
      `\u{2022} *Busiest waiver wire:* ${s.mostSwaps.manager} \u{2014} ${s.mostSwaps.count} approved swap${s.mostSwaps.count === 1 ? '' : 's'}`
    );
  }
  if (!lines.length) return '';
  return [`${CHART} *Season superlatives*`, ...lines].join('\n');
}

// "two Cups" / "one Cup" — the small pluraliser the history line needs.
function recapPlural(n, word) {
  const v = Number(n) || 0;
  return `${v} ${word}${v === 1 ? '' : 's'}`;
}

// One line of career context for a podium finisher, read off the finished-season record.
//
// `history` is managerPlayoffHistory's result, and the caller passes `throughYear: <this
// season>` — so everything here is what was true BEFORE today, which is what makes it worth
// saying. The tenses are past on purpose: this season is the thing the line gives context to,
// never a season the line is counting.
export function recapHistoryFact(name, history, place) {
  if (!history || !history.seasonsPlayed) {
    return `${name} had no finished WMMC season on record before this one.`;
  }
  const seasons = recapPlural(history.seasonsPlayed, 'season');
  const finalsLost = Math.max(0, (history.finalsAppearances || 0) - (history.titleCount || 0));

  if (place === 1) {
    if (!history.titleCount) {
      return finalsLost > 0
        ? `${name} had lost ${recapPlural(finalsLost, 'Final')} across ${seasons} and never won one. That is over.`
        : `${name} had gone ${seasons} without a Cup.`;
    }
    return `${name} had already won ${recapPlural(history.titleCount, 'Cup')}, the last in ${history.lastTitle}.`;
  }
  if (place === 2) {
    if (history.titleCount) {
      return `${name} has ${recapPlural(history.titleCount, 'Cup')} at home, the last in ${history.lastTitle}, and did not add one.`;
    }
    return finalsLost > 0
      ? `${name} had already lost ${recapPlural(finalsLost, 'Final')} before this one.`
      : `${name} had never reached a Final in ${seasons}. Reached one. Lost it.`;
  }
  if (history.titleCount) {
    return `${name} won it in ${history.lastTitle}, which is a long way from here.`;
  }
  if (history.neverMadeFinals) {
    return `${name} has still never reached a Final, ${seasons} in.`;
  }
  const best = (history.seasons || []).reduce((lo, s) => (lo === null || s.place < lo.place ? s : lo), null);
  return best
    ? `${name}'s best finish before this year was ${recapOrdinal(best.place)}, in ${best.year}.`
    : `${name} is ${seasons} into a WMMC career.`;
}

// One career line per podium finisher, already written by the caller from the historical
// results table. Labelled rather than wrapped whole in italics for the same reason the round
// preview labels its history line: it keeps a non-name word first.
export function buildHistoryBlock(historyLines) {
  const lines = (historyLines || []).filter((l) => typeof l === 'string' && l.trim());
  if (!lines.length) return '';
  return [`${BASEBALL} *For the record*`, ...lines.map((l) => `> _History:_ ${l.trim()}`)].join('\n');
}

// The written wrap, when the model is unavailable. Four banks, one per voice ROAST_VOICE asks
// for, so an API failure changes WHO wrote the season's last post rather than how the league
// sounds. Keep that property when adding lines. Every line is built from supplied facts only —
// this bank can no more invent a number than the model is allowed to.
export function fallbackSeasonRecap(facts) {
  const f = facts || {};
  const champ = f.champion || 'somebody';
  const runnerUp = f.runnerUp || 'the other guy';
  const fourth = f.fourth;
  const margin = f.championship ? fmtRecapScore(f.championship.margin) : null;
  const top = f.superlatives && f.superlatives.seasonPoints;

  const banks = [
    // The anchor's swagger.
    () =>
      `And that's the season. ${champ} takes the Cup${margin ? ` by ${margin} points` : ''} \u{2014} sixteen weeks of box scores, one name on the thing. ` +
      `${runnerUp} got all the way to the last weekend and found out that the last weekend is the hard one.` +
      (top && top.manager && top.manager !== champ
        ? ` ${top.manager} scored more points than anybody all year and is watching this like the rest of you.`
        : ''),
    // Deadpan.
    () =>
      `${champ} won the ${f.year} Whit Merrifield Memorial Cup${margin ? `, by ${margin} points` : ''}. That is the whole story. ` +
      `${runnerUp} finished second, which is the best of the losers, which is still the losers.` +
      (fourth ? ` ${fourth} finished fourth in a four-man weekend. Somebody had to.` : ''),
    // Escalation.
    () =>
      `${champ} won it. ${champ} won it${margin ? ` by ${margin}` : ''}. ${champ} won it, and now every single one of you has to hear about it until next May. ` +
      `${runnerUp} played the whole season to lose one game, and lost that one.`,
    // The guy at the bar.
    () =>
      `So ${champ} is the champion, which nobody in this league is going to handle well, least of all ${champ}. ` +
      `${runnerUp} was right there${margin ? ` \u{2014} ${margin} points right there` : ''} and gets to think about it all winter, which honestly sounds worse than not making it.` +
      (top && top.manager && top.manager !== champ
        ? ` And ${top.manager} led the whole league in points and won nothing, which is the most fantasy baseball thing that happened all year.`
        : ''),
  ];

  return banks[recapSeed(`${f.year}|${champ}|recap`) % banks.length]();
}

// The whole post. `wrap` is the written season-in-review (Claude's, or fallbackSeasonRecap's);
// everything else is receipts, deliberately BELOW it, so the numbers the wrap leans on are
// visible even when the model got flowery about them.
//
// Returns '' when there is no podium, because a season recap that cannot name a champion is
// not a recap — the caller should fail loudly rather than post a shell.
export function buildSeasonRecapText(facts, wrap) {
  const f = facts || {};
  const podium = buildPodiumBlock(f);
  if (!podium) return '';
  const blocks = [
    podium,
    wrap && String(wrap).trim() ? `${MICROPHONE} *The ${f.year} season, in review*\n\n${String(wrap).trim()}` : '',
    buildFinalStandingsBlock(f.standings),
    buildSuperlativesBlock(f.superlatives),
    buildHistoryBlock(f.historyLines),
    `${LINK} Full season: <http://wmmc.live|wmmc.live>. Same time next year.`,
  ];
  return blocks.filter(Boolean).join('\n\n');
}
