// ============================================================
// WMMC — Playoff daily commentary (pure)
// ============================================================
// The "what actually happened yesterday" paragraph on the daily playoff scoreboard post.
// Once the bracket narrows to four teams a top-3/bottom-3 manager list stops being a
// leaderboard and starts being a list of everybody, so the daily post trades it for the
// matchups themselves plus this: a handful of lines that name the lead changes, the
// collapses, and the career-shaped ironies that a column of numbers cannot.
//
// Two things live here: `buildPlayoffCommentary`, a deterministic template bank, and the pure
// half of the Anthropic path (`commentaryFactSheet` renders the evidence, and
// `commentaryMentionsUnknownScore` / `tidyCommentaryLine` vet what comes back). server.js
// prefers the written version and falls back to the bank on any failure, so the bank is the
// floor rather than the alternative — see generatePlayoffCommentary.
//
// PURE by design — no season data, no rosters, no dates, no network. Every fact is handed in
// already derived by the caller (server.js), so this module can never disagree with the
// scoreboard about a score, and the interesting half of the API path is testable without an API.
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
// Each bank takes a facts object and returns one Slack mrkdwn line. `n(x)` is the short-name
// formatter the caller supplies, so every name in the post reads the same way.
//
// These are the FALLBACK — server.js prefers a Claude-written version and drops to these on
// any failure. They are written in the same four voices `ROAST_VOICE` asks Claude for, so a
// failed API call changes who wrote the post, not how the league sounds: the anchor's swagger
// and simile (Stuart Scott), the deadpan setup landing on a blunt understated punchline (Norm
// Macdonald), escalating repetition turning into an uncomfortable truth (Chris Rock), and the
// loose bar-guy riff into an oddly specific scenario (Shane Gillis). One of each per bank,
// which is also why the banks are four long rather than three.
//
// Invariants the tests hold these to (tests/playoffCommentary.test.js): every flip line says
// "Lead change" / "flipped" / "New leader"; every blowout and nailbiter line interpolates
// `f.daysLeftText` and the margin; every nailbiter says "coin flip" or "separate"; big-day and
// dead-day lines name the manager and print the points. And no line may ever contain "..",
// which is why a name at a full stop goes through `endSentence`.

const flipLines = [
  // Scott: call it like a highlight, with a simile that makes the number mean something.
  (f, n) =>
    `:arrows_counterclockwise: *Lead change in ${f.label}.* ${n(f.leaderNow)} dropped ${fmtPts(f.winnerDelta)} on the day and flipped a ${fmtPts(f.marginBefore)}-pt deficit into a ${fmtPts(f.margin)}-pt lead — smoother than a Sunday afternoon and twice as cold. ${n(f.trailerNow)} felt every degree of it.`,
  // Macdonald: two flat sentences, and the punchline is just the fact.
  (f, n) =>
    `:arrows_counterclockwise: *${f.label} flipped.* ${n(f.trailerNow)} was winning this. Then ${n(f.leaderNow)} put up ${fmtPts(f.winnerDelta)}, and now he's losing it by ${fmtPts(f.margin)}, and I think that's the whole story there.`,
  // Rock: say the lead three times, each time smaller.
  (f, n) =>
    `:arrows_counterclockwise: *${n(f.trailerNow)} had a lead in ${f.label}.* He had a ${fmtPts(f.marginBefore)}-pt lead. He had a ${fmtPts(f.marginBefore)}-pt lead and one afternoon of baseball, and now he is down ${fmtPts(f.margin)} — because ${n(f.leaderNow)} wanted it and he did not.`,
  // Gillis: the oddly specific scenario.
  (f, n) =>
    `:arrows_counterclockwise: *New leader in ${f.label}:* ${n(f.leaderNow)}, by ${fmtPts(f.margin)}, off a ${fmtPts(f.winnerDelta)}-pt day. ${n(f.trailerNow)} led this thing the way you lead a group project — loudly, for about a day, right up until somebody actually did the work.`,
];

const tieBreakLines = [
  (f, n) => `:zap: *${f.label} is no longer level* — ${n(f.leaderNow)} nudged ahead by ${fmtPts(f.margin)}.`,
  (f, n) =>
    `:zap: *${n(f.leaderNow)} broke the tie in ${f.label}*, by ${fmtPts(f.margin)}. Dead even is a nice place to visit, but nobody's putting a banner up for it.`,
  (f, n) =>
    `:zap: They were tied. Now they're not. *${n(f.leaderNow)}* is up ${fmtPts(f.margin)} in ${f.label}, and that is the most exciting sentence available to me this morning.`,
];

const blowoutLines = [
  // Macdonald: understate the disaster.
  (f, n) =>
    `:coffin: *${f.label} is over and nobody told ${endSentence(n(f.trailerNow))}* Down ${fmtPts(f.margin)}${f.daysLeftText}. That is not a deficit, that is a eulogy with a countdown on it.`,
  // Rock: escalate the same number.
  (f, n) =>
    `:coffin: *${fmtPts(f.margin)} points.* Not ${fmtPts(f.margin)} points across a season — ${fmtPts(f.margin)} points in ONE ROUND, and ${n(f.trailerNow)} is still standing in it${f.daysLeftText}. At some point a hole stops being a hole and starts being an address.`,
  // Scott: anchor voice, big call.
  (f, n) =>
    `:coffin: ${n(f.leaderNow)} is beating ${n(f.trailerNow)} by ${fmtPts(f.margin)} in ${f.label}${f.daysLeftText} — that is not a lead, that is a different area code. Somebody go check on the man.`,
  // Gillis: bar-guy riff.
  (f, n) =>
    `:coffin: ${n(f.trailerNow)} is down ${fmtPts(f.margin)} in ${f.label}${f.daysLeftText} and still setting a lineup every morning, like a guy repainting the deck of a boat that is extremely already underwater.`,
];

const nailbiterLines = [
  (f, n) =>
    `:hourglass_flowing_sand: *${f.label} is a coin flip* — ${n(f.leaderNow)} by ${fmtPts(f.margin)}${f.daysLeftText}. One good afternoon decides it, and neither of these guys has had one in a while.`,
  (f, n) =>
    `:hourglass_flowing_sand: ${fmtPts(f.margin)} points separate ${n(f.a)} and ${n(f.b)} in ${f.label}${f.daysLeftText}. That's one start. That's one at-bat with two on. Nobody in this matchup should be sleeping well.`,
  (f, n) =>
    `:hourglass_flowing_sand: *${fmtPts(f.margin)} points is a coin flip*, and ${n(f.leaderNow)} is the side that happens to be up right now${f.daysLeftText}. Enjoy it, I guess.`,
];

const bigDayLines = [
  // Scott.
  (f, n) =>
    `:boom: *${n(f.manager)} went off for ${fmtPts(f.points)}* — biggest haul in the bracket by ${fmtPts(f.gapToNext)}, and he needed every point of it. Man showed up to work while everybody else was still finding parking.`,
  // Macdonald.
  (f, n) =>
    `:boom: *${fmtPts(f.points)} for ${endSentence(n(f.manager))}* Nobody else in the bracket cleared ${fmtPts(f.next)}. So that was nice for him.`,
  // Rock.
  (f, n) =>
    `:boom: ${n(f.manager)} put up ${fmtPts(f.points)}. ${fmtPts(f.points)}! And the next-best guy in this entire bracket managed ${fmtPts(f.next)} — one day does not fix a season, but it sure ruins somebody else's.`,
  // Gillis.
  (f, n) =>
    `:boom: ${n(f.manager)} led every playoff manager with ${fmtPts(f.points)}, which for him is roughly a month's work compressed into an afternoon. Do not get used to it.`,
];

const deadDayLines = [
  // Macdonald.
  (f, n) =>
    `:zzz: *${n(f.manager)} managed ${fmtPts(f.points)}.* A full slate of major league baseball was played yesterday. He was there for all of it.`,
  // Gillis.
  (f, n) =>
    `:zzz: ${fmtPts(f.points)} from ${n(f.manager)} — that is a roster full of guys who each individually decided today was a good day to work on their swing in the cage instead.`,
  // Rock.
  (f, n) =>
    `:zzz: *${n(f.manager)}: ${fmtPts(f.points)}.* Not a bad day. Not a slow day. ${fmtPts(f.points)} points, in the playoffs, on purpose.`,
  // Scott.
  (f, n) =>
    `:zzz: ${n(f.manager)} posted ${fmtPts(f.points)} — colder than the other side of the pillow, and not in the good way we usually mean that.`,
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
        `:chart_with_downwards_trend: *${n(h.manager)} has gone out in the Quarterfinals ${h.qfExitCount} times* in ${h.seasonsPlayed} seasons. The bracket knows his name, his order, and where he parks.`,
      (h, n) =>
        `:chart_with_downwards_trend: ${n(h.manager)} has lost in the Quarterfinals ${h.qfExitCount} times. ${h.qfExitCount} times! At some point that stops being variance and starts being a lifestyle.`,
      (h, n) =>
        `:chart_with_downwards_trend: *${n(h.manager)} in the Quarterfinals.* ${h.qfExitCount} times he has been here. ${h.qfExitCount} times it has ended here. I'm not saying anything, I'm just reading it out.`,
    ],
  },
  {
    id: 'never-final',
    // Not for a 3rd-place-game player: his Final is already gone for this year.
    when: (h, ctx) => h.neverMadeFinals && h.seasonsPlayed >= 4 && ctx.matchupLabel !== '3rd Place',
    texts: [
      (h, n) =>
        `:tickets: *${n(h.manager)} has never played in a Final* — ${h.seasonsPlayed} seasons, ${h.qfExitCount} quarterfinal exits, zero trips to the last weekend. This is the closest the man has ever stood to the thing.`,
      (h, n) =>
        `:tickets: ${h.seasonsPlayed} seasons. No Finals. *${n(h.manager)}* has watched this league hand out ${h.seasonsPlayed} trophies from roughly the same seat every time.`,
      (h, n) =>
        `:tickets: *${n(h.manager)}* is ${h.playoffAppearances} playoff appearances into a career with no Finals in it — he keeps buying tickets to the building and leaving at the seventh.`,
    ],
  },
  {
    id: 'never-past-qf',
    when: (h) => h.neverPastQF && h.playoffAppearances >= 3,
    texts: [
      (h, n) =>
        `:tickets: *${n(h.manager)} has never won a playoff round.* ${h.playoffAppearances} trips to the bracket. Zero rounds won. Ever.`,
      (h, n) =>
        `:tickets: ${h.playoffAppearances} brackets, ${h.playoffAppearances} first-round exits. *${n(h.manager)}* qualifies every year for what appears to be the sole purpose of leaving.`,
    ],
  },
  {
    id: 'defending',
    when: (h, ctx) => h.lastTitle != null && ctx.year != null && Number(ctx.year) - h.lastTitle === 1,
    texts: [
      (h, n) => `:crown: *${n(h.manager)} is the defending champion*, and is at this moment defending it.`,
      (h, n) =>
        `:crown: *${n(h.manager)}* won this thing last year, which means every other man left in the bracket would very much enjoy ending him specifically.`,
    ],
  },
  {
    id: 'drought',
    when: (h, ctx) => h.titleCount > 0 && ctx.year != null && Number(ctx.year) - h.lastTitle >= 3,
    texts: [
      (h, n, ctx) =>
        `:hourglass: *${n(h.manager)} has ${h.titleCount === 1 ? 'a Cup' : `${h.titleCount} Cups`}*, the most recent in ${h.lastTitle} — ${Number(ctx.year) - h.lastTitle} years, and he has found a way to mention it in every one of them.`,
      (h, n, ctx) =>
        `:hourglass: ${Number(ctx.year) - h.lastTitle} years since *${n(h.manager)}* last won the Cup. He brings it up like it happened Tuesday.`,
    ],
  },
  {
    id: 'bridesmaid',
    when: (h) => h.runnerUps.length >= 2 && h.titleCount === 0,
    texts: [
      (h, n) =>
        `:second_place_medal: *${n(h.manager)} has lost ${h.runnerUps.length} Finals* (${h.runnerUps.join(', ')}) and won none. He is extremely good at getting there and historically catastrophic at the last part.`,
      (h, n) =>
        `:second_place_medal: ${h.runnerUps.length} Finals for *${n(h.manager)}*. ${h.runnerUps.length} losses. The man has been to the mountaintop ${h.runnerUps.length} times and taken a photo of somebody else on it every single time.`,
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
        `:sparkles: *${n(h.manager)}'s first ${ctx.round === 'Finals' ? 'Final' : 'Semifinal'} since ${h.lastYearInSemis}.* Whatever he did differently this year, he should write it down, because he clearly did not remember it the last four times.`,
      (h, n, ctx) =>
        `:sparkles: ${n(h.manager)} last got this far in ${h.lastYearInSemis}. *${Number(ctx.year) - h.lastYearInSemis} years* is a long time to wait for another chance to blow it.`,
    ],
  },
  {
    id: 'semis-regular',
    when: (h, ctx) => ctx.round !== 'QF' && h.sfExitCount >= 3 && h.titleCount === 0,
    texts: [
      (h, n) =>
        `:repeat: *${n(h.manager)} has lost ${h.sfExitCount} Semifinals* and won nothing. He is the most reliable participation trophy this league produces.`,
      (h, n) =>
        `:repeat: ${h.sfExitCount} semifinal losses. Zero Cups. *${n(h.manager)}* has built an entire career out of the second-to-last weekend of the season.`,
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

// ---- Claude-generated commentary: the facts, and a guard on what comes back ----
// `buildPlayoffCommentary` above is the floor — a deterministic bank that always produces
// something. When an Anthropic key is configured the server prefers a written version, and
// these two helpers are what make that safe: one renders the facts (and ONLY the facts) that
// the model is allowed to talk about, the other checks that the reply did not invent a score.
// Both are pure, so the interesting half of the API path is testable without an API.

// Everything the model needs to write about yesterday, as plain text. Names are already
// shortened, so the model never sees a full name it might print. No prompt wording here —
// that lives with the API call in server.js; this is the evidence, not the instruction.
export function commentaryFactSheet({
  round = null,
  roundLabel = '',
  year = null,
  matchups = [],
  dailyTotals = {},
  daysLeft = null,
  histories = {},
  shortNames = {},
} = {}) {
  if (!['QF', 'SF', 'Finals'].includes(round)) return null;
  const n = (name) => shortNames[name] || name || '';
  const moves = (matchups || []).filter((m) => m && m.a && m.b).map((m) => matchupMovement(m));
  if (moves.length === 0) return null;

  const out = [];
  out.push(`Round: ${roundLabel || round}${year ? ` of the ${year} season` : ''}`);
  if (daysLeft != null) {
    out.push(daysLeft <= 0 ? 'Days left in the round: none, it is over' : `Days left in the round: ${daysLeft}`);
  }

  out.push('', 'MATCHUPS (round-to-date total, then what they scored yesterday):');
  for (const m of moves) {
    out.push(
      `- ${m.label}: ${n(m.a)} ${fmtPts(m.aTotal)} (yesterday ${fmtDelta(m.aDelta)}) vs ` +
        `${n(m.b)} ${fmtPts(m.bTotal)} (yesterday ${fmtDelta(m.bDelta)})`
    );
    if (m.leaderNow) out.push(`  ${n(m.leaderNow)} leads by ${fmtPts(m.margin)}`);
    else out.push('  dead level');
    if (m.flipped) {
      out.push(
        `  LEAD CHANGE yesterday: ${n(m.trailerNow)} led by ${fmtPts(m.marginBefore)} the previous morning and lost it`
      );
    } else if (m.brokeTie) {
      out.push(`  they were exactly level the previous morning; ${n(m.leaderNow)} broke it`);
    } else if (m.swing < 0) {
      out.push(`  the gap CLOSED by ${fmtPts(Math.abs(m.swing))} yesterday (was ${fmtPts(m.marginBefore)})`);
    } else if (m.swing > 0) {
      out.push(`  the gap WIDENED by ${fmtPts(m.swing)} yesterday (was ${fmtPts(m.marginBefore)})`);
    }
    if (m.margin >= BLOWOUT_MARGIN) out.push('  this one is effectively over');
    else if (m.margin <= NAILBITER_MARGIN) out.push('  this one is a coin flip');
  }

  const dayRows = Object.entries(dailyTotals || {})
    .filter(([manager]) => moves.some((m) => m.a === manager || m.b === manager))
    .map(([manager, points]) => ({ manager, points: Number(points) || 0 }))
    .sort((x, y) => y.points - x.points);
  if (dayRows.length) {
    out.push('', "YESTERDAY'S SCORING, best to worst:");
    for (const r of dayRows) out.push(`- ${n(r.manager)}: ${fmtPts(r.points)}`);
  }

  const careerLines = [];
  for (const m of moves) {
    for (const name of [m.a, m.b]) {
      const h = histories[name];
      if (!h || careerLines.some((l) => l.startsWith(`- ${n(name)}:`))) continue;
      const bits = [`${h.seasonsPlayed} seasons`];
      bits.push(
        h.titleCount ? `${h.titleCount} Cup${h.titleCount === 1 ? '' : 's'} (${h.titles.join(', ')})` : 'no Cups'
      );
      if (h.runnerUps.length) bits.push(`lost ${h.runnerUps.length} Final${h.runnerUps.length === 1 ? '' : 's'}`);
      if (h.neverMadeFinals) bits.push('has NEVER reached a Final');
      if (h.neverPastQF) bits.push('has NEVER won a playoff round');
      if (h.qfExitCount) bits.push(`${h.qfExitCount} quarterfinal exit${h.qfExitCount === 1 ? '' : 's'}`);
      if (h.sfExitCount) bits.push(`${h.sfExitCount} semifinal loss${h.sfExitCount === 1 ? '' : 'es'}`);
      if (h.dnqCount) bits.push(`missed the bracket ${h.dnqCount}x`);
      careerLines.push(`- ${n(name)}: ${bits.join('; ')}`);
    }
  }
  if (careerLines.length) {
    out.push('', 'CAREER RECORD of the managers still playing (finished seasons only):');
    out.push(...careerLines);
  }

  return out.join('\n');
}

// Does `text` quote a decimal number that the fact sheet never mentioned? Scores in this
// league are decimals (48.4, 233.7), so a decimal the evidence does not contain is the model
// having made one up — the single failure that would put a wrong number in the same post as
// the right one. Whole numbers are deliberately NOT checked: "2 of 3", "8 seasons" and "one
// bad afternoon" are ordinary prose, and margins that land on a round number are legitimately
// derivable from two figures that are both present.
export function commentaryMentionsUnknownScore(text, factSheet) {
  const decimals = String(text || '').match(/\d[\d,]*\.\d+/g) || [];
  if (decimals.length === 0) return false;
  const known = new Set((String(factSheet || '').match(/\d[\d,]*\.\d+/g) || []).map((s) => s.replace(/,/g, '')));
  return decimals.some((d) => !known.has(d.replace(/,/g, '')));
}

// Clean up a model-written line: strip any bullet/numbering it added, collapse the doubled
// period an initialled short name produces at a full stop ("Ryan S.."), and trim.
export function tidyCommentaryLine(line) {
  return String(line || '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/([A-Z]\.)\.(?!\.)/g, '$1')
    .trim();
}

// Cache key for a day's takes. The takes are about ONE day's scoring inside ONE round, so
// both belong in the key: a new day obviously invalidates them, and so does a round rolling
// over underneath the same day (the Monday a round ends, "yesterday" belongs to the round
// that just finished). Returns null when either half is missing, which callers treat as
// "not cacheable" rather than as a key that could accidentally match.
export function hotTakesCacheKey(dayISO, round) {
  if (!dayISO || !round) return null;
  return `${dayISO}|${round}`;
}

// Is a stored takes cache still the right answer for this day and round?
export function hotTakesCacheHit(cached, dayISO, round) {
  const key = hotTakesCacheKey(dayISO, round);
  return !!(
    key &&
    cached &&
    cached.key === key &&
    Array.isArray(cached.lines) &&
    cached.lines.length > 0 &&
    cached.lines.every((l) => typeof l === 'string' && l.trim())
  );
}
