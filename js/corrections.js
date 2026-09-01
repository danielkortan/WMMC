// ============================================================
// WMMC — what a refused stat correction is actually made of (pure)
// ============================================================
// The corrections sweep refuses any re-sync that would move a manager by more than
// MLB_CORRECTION_MAX_SWING, on the reasoning that a real stat correction is small and a big
// swing is a bug. That reasoning is sound and the ceiling stays. What it lacked was a way to
// tell a human WHICH bug — and the two candidates want opposite responses:
//
//   * The stat rows disagree with MLB. Something is wrong with the data (a postponed game
//     counted in its original week is the one this repo has actually hit). Do not write it.
//   * The stat rows are fine and their OWNER is stale. A roster fix — an undone swap, a
//     corrected add date — landed in roster_dates but never reached the cached `manager` field
//     on a closed week's rows, because rebuildWeeklyFromDaily only ever runs for the current
//     week. Re-syncing the week IS the repair, and refusing it leaves a manager's points
//     credited to nobody.
//
// Those look identical in a message that says only "wanted to move a manager by 31.1 pts". The
// second one cost this league a semifinal's worth of doubt: 31.1 points sat in nobody's column
// for twelve days while the alert re-fired every Wednesday, because the one fact that would
// have ended it in a glance — the row's SCORE never changed, only its owner — was never in the
// message.
//
// So this module classifies each moved row and says which kind of problem the week has. Pure:
// it is handed already-derived before/after facts and only shapes them, so it can never
// disagree with the sweep about what moved.

// How many rows a refusal message names before it starts counting. Enough to see the shape of
// the problem; not so many that the post becomes a spreadsheet nobody reads.
export const CORRECTION_ROW_LIMIT = 6;

const correctionRound2 = (n) => Math.round(n * 100) / 100;

// A signed score, for prose: 31.1 reads as "+31.1", -7.3 as "-7.3".
export function fmtCorrectionDelta(n) {
  const v = correctionRound2(n || 0);
  return `${v > 0 ? '+' : ''}${v}`;
}

const correctionManagerLabel = (m) => m || '(nobody)';
const correctionTypeLabel = (t) => (t === 'batting' ? 'bat' : 'pit');

// One row's before/after, classified.
//
// `kind` answers "what changed about this row":
//   'score'   — the numbers moved, the owner did not. A stat difference.
//   'owner'   — the numbers are identical, the row changed hands. An attribution repair.
//   'both'    — both moved.
//   'added' / 'removed' — the row did not exist on one side. A re-sync creating or purging a
//               row is neither a stat correction nor an attribution fix, and the removal case
//               is invisible to any diff that only walks the rows that exist afterwards.
//
// `impact` is what the row can move on a scoreboard, which is NOT the same as its score delta:
// an owner-only change moves the row's whole score from one manager to another, so a 31.1-point
// row that changed hands is a 31.1-point event even though its delta is zero.
export function classifyCorrectionRow(row) {
  const storedScore = correctionRound2(row.storedScore || 0);
  const resyncScore = correctionRound2(row.resyncScore || 0);
  const storedManager = row.storedManager || null;
  const resyncManager = row.resyncManager || null;
  const scoreDiff = correctionRound2(resyncScore - storedScore);
  const ownerChanged = storedManager !== resyncManager;

  let kind = null;
  if (row.existedBefore === false) kind = 'added';
  else if (row.existsAfter === false) kind = 'removed';
  else if (scoreDiff !== 0 && ownerChanged) kind = 'both';
  else if (scoreDiff !== 0) kind = 'score';
  else if (ownerChanged) kind = 'owner';

  const impact =
    kind === 'owner' || kind === 'both'
      ? Math.max(Math.abs(scoreDiff), Math.abs(resyncScore), Math.abs(storedScore))
      : Math.abs(kind === 'removed' ? storedScore : scoreDiff);

  return {
    player: row.player,
    type: row.type,
    storedScore,
    resyncScore,
    storedManager,
    resyncManager,
    scoreDiff,
    ownerChanged,
    kind,
    impact: correctionRound2(impact),
  };
}

// Every row that moved, biggest first, plus the week's verdict.
//
// The verdict is the sentence a commissioner reads instead of opening a console:
//   'attribution' — nothing's score changed; only owners did. A roster fix that never reached
//                   this week. Re-syncing the week is the repair, not a risk.
//   'stats'       — only scores changed. A genuine data difference; look before writing.
//   'mixed'       — both, so look at the owner rows first: those are usually the repair.
//   'none'        — nothing moved at row level (the swing came from somewhere else entirely,
//                   which is itself worth knowing).
export function summarizeCorrectionRows(rows) {
  const classified = (rows || [])
    .map(classifyCorrectionRow)
    .filter((r) => r.kind)
    .sort((a, b) => b.impact - a.impact || String(a.player).localeCompare(String(b.player)));

  const scoreMoved = classified.filter((r) => r.kind === 'score' || r.kind === 'both').length;
  const ownerMoved = classified.filter((r) => r.kind === 'owner' || r.kind === 'both').length;
  const structural = classified.filter((r) => r.kind === 'added' || r.kind === 'removed').length;

  let verdict = 'none';
  if (classified.length) {
    if (scoreMoved && ownerMoved) verdict = 'mixed';
    else if (ownerMoved) verdict = 'attribution';
    else if (scoreMoved) verdict = 'stats';
    // Only rows appearing or vanishing. Neither a stat correction nor an attribution fix, and
    // worth its own name: a re-sync that would DELETE a stored row is the one shape of this
    // that silently removes points nobody asked to remove.
    else verdict = 'structural';
  }

  return { rows: classified, scoreMoved, ownerMoved, structural, verdict };
}

// One row as a Slack bullet. The owner case leads with the handover, because that is the whole
// point of the line; the score case leads with the numbers, for the same reason.
export function correctionRowLine(r) {
  const where = `\u{2022} *${r.player}* (${correctionTypeLabel(r.type)})`;
  if (r.kind === 'added') {
    return `${where} — row did not exist before, now ${r.resyncScore} pts (owner ${correctionManagerLabel(r.resyncManager)})`;
  }
  if (r.kind === 'removed') {
    return `${where} — row would be REMOVED, was ${r.storedScore} pts (owner ${correctionManagerLabel(r.storedManager)})`;
  }
  if (r.kind === 'owner') {
    return (
      `${where} — owner changed: ${correctionManagerLabel(r.storedManager)} \u{2192} ` +
      `${correctionManagerLabel(r.resyncManager)}, ${r.resyncScore} pts, score unchanged`
    );
  }
  if (r.kind === 'both') {
    return (
      `${where} — owner changed: ${correctionManagerLabel(r.storedManager)} \u{2192} ` +
      `${correctionManagerLabel(r.resyncManager)}, and score ${r.storedScore} \u{2192} ${r.resyncScore} ` +
      `(${fmtCorrectionDelta(r.scoreDiff)})`
    );
  }
  return `${where} — score ${r.storedScore} \u{2192} ${r.resyncScore} (${fmtCorrectionDelta(r.scoreDiff)}), owner unchanged`;
}

// The one line that tells the commissioner what to DO about this week.
export function correctionVerdictLine(summary) {
  if (summary.verdict === 'attribution') {
    return (
      `_Every row that moved changed OWNER, not score._ That is a roster fix (an undone swap, a ` +
      `corrected date) that never reached this closed week's cached rows — re-syncing the week is ` +
      `the repair, not a risk. Points are currently credited to the wrong manager, or to nobody.`
    );
  }
  if (summary.verdict === 'stats') {
    return (
      `_Every row that moved changed SCORE, with no change of owner._ That is a genuine stat ` +
      `difference — check for a game counted in the wrong week before writing it.`
    );
  }
  if (summary.verdict === 'structural') {
    return (
      `_${summary.structural} row(s) would be ADDED or REMOVED, with no score or owner change on ` +
      `any existing row._ A re-sync that deletes a stored row takes its points with it — check what ` +
      `those rows are before writing this.`
    );
  }
  if (summary.verdict === 'mixed') {
    return (
      `_${summary.ownerMoved} row(s) changed owner and ${summary.scoreMoved} changed score._ Look at ` +
      `the owner rows first — those are usually a roster fix that never reached this week, not an anomaly.`
    );
  }
  return `_No stat row moved at all_ — the swing came from outside this week's rows. Worth a look on its own.`;
}

// The refused-week Slack post.
//
// `flagged` is [{ week, maxSwing, diffs: [{ manager, diff }], summary }] — already-derived
// facts, one entry per refused week. `summary` is what summarizeCorrectionRows returned, and
// may be absent (a caller that could not capture rows still gets the old, thinner message
// rather than no message).
export function buildCorrectionRefusalText(flagged, threshold) {
  const weeks = flagged || [];
  if (!weeks.length) return '';

  const head =
    `:warning: *WMMC corrections sweep refused ${weeks.length} week(s).* A re-sync wanted to move a ` +
    `manager by more than ${threshold} pts, which is too large to be a stat correction. Nothing was written.`;

  const blocks = weeks.map((w) => {
    const movers = (w.diffs || []).map((d) => `${d.manager} ${fmtCorrectionDelta(d.diff)}`).join(', ');
    const lines = [`*${w.week}* — ${movers || 'no manager named'}`];

    // A summary that found NO moved rows is not the same as no summary at all, and the
    // difference matters: the first says "we looked and the swing is not in this week's rows",
    // which is a finding; the second says "we could not look", which is a thinner message.
    // Only the row bullets are conditional on there being rows — the verdict always prints.
    const summary = w.summary;
    if (summary) {
      for (const r of summary.rows.slice(0, CORRECTION_ROW_LIMIT)) lines.push(correctionRowLine(r));
      const hidden = summary.rows.length - CORRECTION_ROW_LIMIT;
      if (hidden > 0) lines.push(`\u{2022} …and ${hidden} more row(s)`);
      lines.push(correctionVerdictLine(summary));
    }
    return lines.join('\n');
  });

  return [head, ...blocks].join('\n\n');
}

// The same facts, compressed to one line per week for a console log.
export function correctionRefusalLogLine(flagged) {
  return (flagged || [])
    .map((w) => {
      const movers = (w.diffs || []).map((d) => `${d.manager} ${fmtCorrectionDelta(d.diff)}`).join(', ');
      const verdict = w.summary ? ` [${w.summary.verdict}]` : '';
      return `${w.week}${verdict}: ${movers}`;
    })
    .join(' | ');
}
