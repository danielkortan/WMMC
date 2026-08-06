// ============================================================
// WMMC — Playoff daily commentary (pure)
// ============================================================
// The "what actually happened yesterday" paragraph on the daily playoff scoreboard post.
// Once the bracket narrows to four teams a top-3/bottom-3 manager list stops being a
// leaderboard and starts being a list of everybody, so the daily post trades it for the
// matchups themselves plus this: a handful of lines that name the lead changes, the
// collapses, and the career-shaped ironies that a column of numbers cannot.
//
// PURE by design — no season data, no rosters, no dates. Every fact is handed in already
// derived by the caller (server.js), so this module can never disagree with the scoreboard
// about a score, and the whole thing is testable without a database.
//
// server.js keeps a synced duplicate of this file's logic because it cannot import an ES
// module; this copy is the canonical, unit-tested one. Same rule as detectScoreSwings —
// every edit goes in both.

// A margin this big, this late, is not a deficit any more.
const BLOWOUT_MARGIN = 120;
// Below this the matchup is a coin flip and worth saying so.
const NAILBITER_MARGIN = 25;
// A daily haul has to clear this to be worth a sentence of its own.
const BIG_DAY_POINTS = 40;
// ...and a shutout day has to be under this to be worth mocking.
const DEAD_DAY_POINTS = 5;

// One decimal, with the redundant ".0" dropped — matches the Slack scoreboard's own
// formatter so a number never appears twice in one post wearing two different faces.
export function fmtPts(n) {
  const s = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Signed form for a day's movement: "+48.4", "-3.2", "+0".
export function fmtDelta(n) {
  const v = Number(n || 0);
  return `${v < 0 ? '-' : '+'}${fmtPts(Math.abs(v))}`;
}

// Deterministic pick from a bank. Seeded off the date (not Math.random) so re-running the
// same day's post — a retry, a manual repost — tells the same joke instead of rerolling it.
function pickLine(bank, seed, offset = 0) {
  if (!bank || bank.length === 0) return null;
  return bank[Math.abs(seed + offset) % bank.length];
}

// Sentence-final period after something that may already end in one. Short manager names can
// be initials ("Ryan S."), and English collapses the abbreviation period into the sentence
// period rather than printing "Ryan S..". Use this anywhere a name can land at a full stop.
export function endSentence(s) {
  const t = String(s == null ? '' : s);
  return t.endsWith('.') ? t : `${t}.`;
}

// Sum of a string's char codes — the seed the daily post already uses for its worst-player
// roast, so both roasts on one post move together from day to day.
export function seedFromDate(dateISO) {
  return String(dateISO || '')
    .split('')
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
}

// What one head-to-head matchup did yesterday. `aDelta`/`bDelta` are yesterday's points
// only, so subtracting them from the round totals gives the standings as of the previous
// morning — which is the only way to know a lead actually changed hands.
export function matchupMovement({ label, a, b, aTotal = 0, bTotal = 0, aDelta = 0, bDelta = 0 } = {}) {
  const marginNow = aTotal - bTotal;
  const marginBefore = aTotal - aDelta - (bTotal - bDelta);
  const leaderNow = marginNow === 0 ? null : marginNow > 0 ? a : b;
  const leaderBefore = marginBefore === 0 ? null : marginBefore > 0 ? a : b;
  const trailerNow = leaderNow === null ? null : leaderNow === a ? b : a;
  return {
    label,
    a,
    b,
    aTotal,
    bTotal,
    aDelta,
    bDelta,
    leaderNow,
    leaderBefore,
    trailerNow,
    // A flip needs a real leader on both sides of the day — coming out of a dead tie is a
    // lead taken, not a lead change, and gets its own line.
    flipped: !!(leaderNow && leaderBefore && leaderNow !== leaderBefore),
    brokeTie: !!(leaderNow && !leaderBefore),
    margin: Math.abs(marginNow),
    marginBefore: Math.abs(marginBefore),
    // Positive when the day pushed the two further apart, negative when it closed the gap.
    swing: Math.abs(marginNow) - Math.abs(marginBefore),
    dayWinner: aDelta === bDelta ? null : aDelta > bDelta ? a : b,
    dayGap: Math.abs(aDelta - bDelta),
  };
}

// ---- Line banks -------------------------------------------------------------
// Each bank takes a facts object and returns one Slack mrkdwn line. `n(x)` is the
// short-name formatter the caller supplies, so every name in the post reads the same way.

const flipLines = [
  (f, n) =>
    `:arrows_counterclockwise: *Lead change in ${f.label}.* ${n(f.leaderNow)} put up ${fmtPts(f.winnerDelta)} and turned a ${fmtPts(f.marginBefore)}-pt deficit into a ${fmtPts(f.margin)}-pt lead. ${n(f.trailerNow)} watched it happen in real time.`,
  (f, n) =>
    `:arrows_counterclockwise: *${f.label} flipped.* ${n(f.trailerNow)} woke up in front and went to bed ${fmtPts(f.margin)} behind — ${n(f.leaderNow)}'s ${fmtPts(f.winnerDelta)} did it in a single day.`,
  (f, n) =>
    `:arrows_counterclockwise: *New leader in ${f.label}:* ${n(f.leaderNow)}, by ${fmtPts(f.margin)}, off a ${fmtPts(f.winnerDelta)}-pt day. ${n(f.trailerNow)} held that lead for exactly as long as he could.`,
];

const tieBreakLines = [
  (f, n) => `:zap: *${f.label} is no longer level* — ${n(f.leaderNow)} nudged ahead by ${fmtPts(f.margin)}.`,
  (f, n) => `:zap: *${n(f.leaderNow)} broke the tie in ${f.label}*, and leads by ${fmtPts(f.margin)}.`,
];

const blowoutLines = [
  (f, n) =>
    `:coffin: *${f.label} is over and nobody told ${endSentence(n(f.trailerNow))}* Down ${fmtPts(f.margin)}${f.daysLeftText}. That is not a deficit, that is a eulogy.`,
  (f, n) =>
    `:coffin: ${n(f.leaderNow)} leads ${n(f.trailerNow)} by ${fmtPts(f.margin)} in ${f.label}${f.daysLeftText}. At this point ${n(f.trailerNow)} is just accumulating evidence.`,
  (f, n) =>
    `:coffin: *${fmtPts(f.margin)} points.* That is the hole ${n(f.trailerNow)} is in${f.daysLeftText}, and he keeps digging like there is something down there.`,
];

const nailbiterLines = [
  (f, n) =>
    `:hourglass_flowing_sand: *${f.label} is a coin flip* — ${n(f.leaderNow)} by ${fmtPts(f.margin)}${f.daysLeftText}. One good afternoon decides it.`,
  (f, n) =>
    `:hourglass_flowing_sand: ${fmtPts(f.margin)} points separate ${n(f.a)} and ${n(f.b)} in ${f.label}${f.daysLeftText}. Nobody should be sleeping well.`,
];

const bigDayLines = [
  (f, n) =>
    `:boom: *${n(f.manager)} put up ${fmtPts(f.points)}* — the biggest haul of the day by ${fmtPts(f.gapToNext)}, and the only reason he is still in this conversation.`,
  (f, n) =>
    `:boom: *${fmtPts(f.points)} for ${endSentence(n(f.manager))}* Nobody else in the bracket cleared ${fmtPts(f.next)}.`,
  (f, n) =>
    `:boom: ${n(f.manager)} led all playoff managers with ${fmtPts(f.points)}. One day does not fix a bracket, but it is a start.`,
];

const deadDayLines = [
  (f, n) =>
    `:zzz: *${n(f.manager)} managed ${fmtPts(f.points)}.* An entire slate of baseball happened and his roster sat through it like a hostage video.`,
  (f, n) =>
    `:zzz: ${fmtPts(f.points)} from ${n(f.manager)} — the fantasy equivalent of forgetting to set an alarm on the day of the exam.`,
  (f, n) => `:zzz: *${n(f.manager)}: ${fmtPts(f.points)}.* His players showed up, signed in, and went home.`,
];

// ---- History lines ----------------------------------------------------------
// Career facts only become interesting when they are a pattern, so each of these is gated
// on a real streak or a real absence — never "he lost once, three years ago".

// Each rule carries a small bank of phrasings rather than one line: a playoff round runs for
// two weeks, and the career fact does not change over those two weeks even though everything
// else on the post does. Rotating the wording by seed keeps the same true statement from
// reading like a stuck record.
const historyLines = [
  // A manager who cannot get out of the quarterfinals, in the quarterfinals.
  {
    id: 'qf-serial',
    when: (h, ctx) => ctx.round === 'QF' && h.qfExitCount >= 3,
    texts: [
      (h, n) =>
        `:chart_with_downwards_trend: *${n(h.manager)} has gone out in the Quarterfinals ${h.qfExitCount} times* in ${h.seasonsPlayed} seasons. The bracket knows where he lives.`,
      (h, n) =>
        `:chart_with_downwards_trend: ${h.qfExitCount} quarterfinal exits in ${h.seasonsPlayed} seasons for *${n(h.manager)}*. At some point it stops being bad luck and starts being a personality.`,
      (h, n) =>
        `:chart_with_downwards_trend: *${n(h.manager)} in the Quarterfinals* is the most predictable event in this league, and it has happened ${h.qfExitCount} times.`,
    ],
  },
  {
    id: 'never-final',
    // Not for a 3rd-place-game player: his Final is already gone for this year.
    when: (h, ctx) => h.neverMadeFinals && h.seasonsPlayed >= 4 && ctx.matchupLabel !== '3rd Place',
    texts: [
      (h, n) =>
        `:tickets: *${n(h.manager)} has never played in a Final* — ${h.seasonsPlayed} seasons, ${h.qfExitCount} quarterfinal exits, zero trips to the last weekend. This is the closest he has been.`,
      (h, n) =>
        `:tickets: ${h.seasonsPlayed} seasons, zero Finals. *${n(h.manager)}* has spent his entire career watching other people play the last game.`,
      (h, n) =>
        `:tickets: *${n(h.manager)}* is ${h.playoffAppearances} playoff appearances into a career with no Finals in it. The drought has its own drought.`,
    ],
  },
  {
    id: 'never-past-qf',
    when: (h) => h.neverPastQF && h.playoffAppearances >= 3,
    texts: [
      (h, n) =>
        `:tickets: *${n(h.manager)} has never won a playoff round* in ${h.playoffAppearances} trips to the bracket. Ever.`,
      (h, n) =>
        `:tickets: ${h.playoffAppearances} brackets, ${h.playoffAppearances} first-round exits. *${n(h.manager)}* qualifies for the sole purpose of leaving.`,
    ],
  },
  {
    id: 'defending',
    when: (h, ctx) => h.lastTitle != null && ctx.year != null && Number(ctx.year) - h.lastTitle === 1,
    texts: [
      (h, n) => `:crown: *${n(h.manager)} is the defending champion*, and is currently defending it.`,
      (h, n) =>
        `:crown: *${n(h.manager)}* won this thing last year, which means everyone left in the bracket would enjoy ending him specifically.`,
    ],
  },
  {
    id: 'drought',
    when: (h, ctx) => h.titleCount > 0 && ctx.year != null && Number(ctx.year) - h.lastTitle >= 3,
    texts: [
      (h, n, ctx) =>
        `:hourglass: *${n(h.manager)} has ${h.titleCount === 1 ? 'a Cup' : `${h.titleCount} Cups`}*, the most recent in ${h.lastTitle} — ${Number(ctx.year) - h.lastTitle} years of being reminded about it.`,
      (h, n, ctx) =>
        `:hourglass: ${Number(ctx.year) - h.lastTitle} years since *${n(h.manager)}* last won the Cup, and he has brought it up in roughly that many conversations.`,
    ],
  },
  {
    id: 'bridesmaid',
    when: (h) => h.runnerUps.length >= 2 && h.titleCount === 0,
    texts: [
      (h, n) =>
        `:second_place_medal: *${n(h.manager)} has lost ${h.runnerUps.length} Finals* (${h.runnerUps.join(', ')}) and won none. The trophy case is a mirror.`,
      (h, n) =>
        `:second_place_medal: ${h.runnerUps.length} Finals, ${h.runnerUps.length} losses. *${n(h.manager)}* is very good at getting there and historically bad at the last part.`,
    ],
  },
  {
    id: 'back-from-nowhere',
    when: (h, ctx) =>
      ctx.round !== 'QF' &&
      ctx.matchupLabel !== '3rd Place' &&
      h.lastYearInSemis != null &&
      Number(ctx.year) - h.lastYearInSemis >= 4,
    texts: [
      (h, n, ctx) =>
        `:sparkles: *${n(h.manager)}'s first ${ctx.round === 'Finals' ? 'Final' : 'Semifinal'} since ${h.lastYearInSemis}.* Whatever he did differently, he should write it down.`,
      (h, n, ctx) =>
        `:sparkles: ${n(h.manager)} last got this far in ${h.lastYearInSemis}. *${Number(ctx.year) - h.lastYearInSemis} years* is a long time to wait for another chance to blow it.`,
    ],
  },
  {
    id: 'semis-regular',
    when: (h, ctx) => ctx.round !== 'QF' && h.sfExitCount >= 3 && h.titleCount === 0,
    texts: [
      (h, n) =>
        `:repeat: *${n(h.manager)} has lost ${h.sfExitCount} Semifinals* and won nothing. He is the league's most reliable participation trophy.`,
      (h, n) =>
        `:repeat: ${h.sfExitCount} semifinal losses, zero Cups. *${n(h.manager)}* has made a career out of the second-to-last weekend.`,
    ],
  },
];

// ---- Assembly ---------------------------------------------------------------

// Build the commentary lines for one daily playoff post.
//
//   round        — 'QF' | 'SF' | 'Finals'
//   roundLabel   — 'Semifinals' (display only)
//   year         — the season, for the history lines' arithmetic
//   matchups     — [{ label, a, b, aTotal, bTotal, aDelta, bDelta }], already scored by the
//                  caller from the same numbers the matchup block prints
//   dailyTotals  — { manager: yesterday's points } for the round's participants
//   daysLeft     — whole days left in the round including today, or null when unknown
//   histories    — { manager: managerPlayoffHistory(...) | null }
//   shortNames   — { manager: display name }
//   seed         — deterministic template seed (seedFromDate(yesterdayISO))
//   maxLines     — cap, default 4
//
// Returns [] when there is nothing worth saying — the caller drops the whole section rather
// than printing a heading over an empty list.
export function buildPlayoffCommentary({
  round = null,
  roundLabel = '',
  year = null,
  matchups = [],
  dailyTotals = {},
  daysLeft = null,
  histories = {},
  shortNames = {},
  seed = 0,
  maxLines = 4,
} = {}) {
  if (!['QF', 'SF', 'Finals'].includes(round)) return [];
  const n = (name) => shortNames[name] || name || '';
  const daysLeftText =
    daysLeft == null
      ? ''
      : daysLeft <= 0
        ? ' with the round already over'
        : ` with ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;

  const moves = (matchups || []).filter((m) => m && m.a && m.b).map((m) => matchupMovement(m));
  if (moves.length === 0) return [];

  const lines = [];
  const usedManagers = new Set();
  const add = (text, ...managers) => {
    if (!text || lines.length >= maxLines || lines.includes(text)) return;
    lines.push(text);
    managers.filter(Boolean).forEach((m) => usedManagers.add(m));
  };

  // 1. Lead changes first — nothing else that happened yesterday outranks one.
  moves
    .filter((m) => m.flipped)
    .forEach((m, i) => {
      const winnerDelta = m.leaderNow === m.a ? m.aDelta : m.bDelta;
      add(pickLine(flipLines, seed, i)({ ...m, winnerDelta }, n), m.leaderNow, m.trailerNow);
    });
  moves
    .filter((m) => m.brokeTie)
    .forEach((m, i) => add(pickLine(tieBreakLines, seed, i)(m, n), m.leaderNow, m.trailerNow));

  // 2. The most lopsided matchup, then the closest one — the two shapes a manager actually
  //    wants to know about when he opens Slack.
  const blowouts = moves.filter((m) => m.margin >= BLOWOUT_MARGIN).sort((a, b) => b.margin - a.margin);
  if (blowouts.length) {
    const m = blowouts[0];
    add(pickLine(blowoutLines, seed, 1)({ ...m, daysLeftText }, n), m.leaderNow, m.trailerNow);
  }
  const tight = moves.filter((m) => m.margin <= NAILBITER_MARGIN).sort((a, b) => a.margin - b.margin);
  if (tight.length) {
    const m = tight[0];
    add(pickLine(nailbiterLines, seed, 2)({ ...m, daysLeftText }, n), m.a, m.b);
  }

  // 3. The day's best and worst hauls, but only when they are extreme enough to carry a
  //    sentence, and only for managers no line has already named.
  const dayRows = Object.entries(dailyTotals || {})
    .filter(([manager]) => moves.some((m) => m.a === manager || m.b === manager))
    .map(([manager, points]) => ({ manager, points: Number(points) || 0 }))
    .sort((x, y) => y.points - x.points);
  if (dayRows.length >= 2) {
    const best = dayRows[0];
    const next = dayRows[1];
    if (best.points >= BIG_DAY_POINTS && !usedManagers.has(best.manager)) {
      add(
        pickLine(bigDayLines, seed, 3)({ ...best, next: next.points, gapToNext: best.points - next.points }, n),
        best.manager
      );
    }
    const worst = dayRows[dayRows.length - 1];
    if (worst.points <= DEAD_DAY_POINTS && !usedManagers.has(worst.manager)) {
      add(pickLine(deadDayLines, seed, 4)(worst, n), worst.manager);
    }
  }

  // 4. One history line, from whichever still-playing manager has the sharpest pattern.
  //    Ordered by the bank's own priority (the earliest matching rule wins), tie-broken by
  //    the seed so the same fixed situation does not print the same manager every morning.
  //
  //    Each candidate is judged with its OWN matchup label in context, because in the Finals
  //    the two games mean opposite things: "he has never reached a Final, and this is the
  //    closest he has been" is a true and pointed thing to say to a championship-game player
  //    and a false one to say to somebody in the 3rd-place game, who already lost his semi.
  const field = [];
  const matchupLabelOf = {};
  moves.forEach((m) => {
    field.push(m.a, m.b);
    matchupLabelOf[m.a] = m.label;
    matchupLabelOf[m.b] = m.label;
  });
  const ctx = { round, roundLabel, year };
  const candidates = [];
  field.forEach((manager) => {
    const h = histories[manager];
    if (!h) return;
    const mctx = { ...ctx, matchupLabel: matchupLabelOf[manager] || null };
    historyLines.forEach((rule, rank) => {
      if (rule.when(h, mctx)) candidates.push({ rank, rule, h, ctx: mctx });
    });
  });
  if (candidates.length) {
    candidates.sort((x, y) => x.rank - y.rank);
    const bestRank = candidates[0].rank;
    const tied = candidates.filter((c) => c.rank === bestRank);
    const chosen = tied[Math.abs(seed) % tied.length];
    add(pickLine(chosen.rule.texts, seed, 5)(chosen.h, n, chosen.ctx), chosen.h.manager);
  }

  return lines;
}
