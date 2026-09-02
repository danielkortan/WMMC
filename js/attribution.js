// ============================================================
// WMMC — Weekly-row attribution
// ============================================================
// The `manager` field on a weekly_batting / weekly_pitching row says who is credited with that
// player that week. It is a DERIVED CACHE — the authority is roster_dates — but managerWeekSubtotal
// reads it directly (`rowsArr.filter((r) => r.manager === managerName)`, plus a wrong-owner gate),
// so a wrong value is a scoring bug, not a display bug.
//
// It is written in exactly one place: rebuildWeeklyFromDaily, which only ever runs for the week
// being synced. Once a week closes, its attribution is frozen forever, and recomputeAllWeeklyScores
// recomputes every week's SCORE while never touching `manager`. So there has been no way to repair
// one. On 2026-08-31 that cost the league twelve days of a semifinal with 31.1 points credited to
// nobody, through the round that decided the Championship pairing.
//
// This module is the pure half of the repair: given who actually owned a player in a week, work out
// what each row's `manager` should say and what would change. Deriving the owners is the server's
// job (managerWeekRosterWindows, off roster_dates) — deliberately NOT findManagerForPlayerWeek,
// which reads the sd.rosters ARRAY cache and so would re-derive attribution from a second cache
// that is itself additive-only and can be stale.
//
// Canonical copy. Mirrored verbatim in server.js and guarded by tests/serverMirrors.test.js.

// Which manager a row should name when more than one held the player inside one week.
//
// A mid-week handover (dropped by A on the 28th, added by B on the 29th) genuinely has two owners,
// and the row's points are split between them by `manager_scores` regardless of what this returns —
// so this is choosing a LABEL, not deciding who scores. The label goes to whoever held him at the
// week's end: it is the answer a reader expects from "whose player was this", and it matches what
// the sync would have stamped had it run on the last day of the week.
//
// `windowsByManager` maps manager -> { start, end } (either side null when that side is the week's
// own boundary). Returns { owner, contested }.
export function chooseOwner(windowsByManager) {
  const entries = Object.entries(windowsByManager || {});
  if (entries.length === 0) return { owner: null, contested: false };
  if (entries.length === 1) return { owner: entries[0][0], contested: false };

  // Latest start wins (a null start means "held from the week's first day", so it loses to any
  // explicit later add). Then latest end, then the name, so the result never depends on key order.
  const sorted = entries.slice().sort((a, b) => {
    const as = a[1] && a[1].start ? a[1].start : '';
    const bs = b[1] && b[1].start ? b[1].start : '';
    if (as !== bs) return as < bs ? 1 : -1;
    const ae = a[1] && a[1].end ? a[1].end : '￿';
    const be = b[1] && b[1].end ? b[1].end : '￿';
    if (ae !== be) return ae < be ? 1 : -1;
    return a[0].localeCompare(b[0]);
  });
  return { owner: sorted[0][0], contested: true };
}

// What one week's rows would change to. `rows` are that week's weekly_* rows, `playerKey` is
// 'batter' or 'pitcher', and `ownerByPlayer` maps a player name to the result of chooseOwner.
//
// Reports rather than mutates, so the same call drives both the dry run and the apply. A row whose
// `manager` already matches is not reported at all.
export function planReattribution(rows, playerKey, ownerByPlayer) {
  const changes = [];
  for (const row of rows || []) {
    const player = row[playerKey];
    const resolved = (ownerByPlayer && ownerByPlayer[player]) || { owner: null, contested: false };
    const from = row.manager || null;
    const to = resolved.owner || null;
    if (from === to) continue;
    changes.push({
      round: row.round,
      week: row.week,
      type: playerKey === 'batter' ? 'batting' : 'pitching',
      player,
      from,
      to,
      contested: !!resolved.contested,
      weekly_score: row.weekly_score || 0,
      kind: !from ? 'claimed' : !to ? 'released' : 'moved',
    });
  }
  return changes;
}

// Group the changes into the three things a commissioner actually needs to judge before applying.
//
// `claimed` is a row nobody was credited with that somebody now is — the 8/31 shape, and the one
// that only ever adds points back. `moved` is a row changing hands. `released` is a row that stops
// counting for anyone: the only direction that can take points away from a manager, so it is
// listed separately and named in full rather than counted.
export function summarizeReattribution(changes) {
  const claimed = [];
  const moved = [];
  const released = [];
  for (const c of changes || []) {
    if (c.kind === 'claimed') claimed.push(c);
    else if (c.kind === 'released') released.push(c);
    else moved.push(c);
  }
  const weeks = new Set((changes || []).map((c) => `${c.round}|${c.week}`));
  return {
    total: (changes || []).length,
    claimed: claimed.length,
    moved: moved.length,
    released: released.length,
    contested: (changes || []).filter((c) => c.contested).length,
    weeks: [...weeks].sort(),
    released_rows: released,
  };
}

// One line per change, for a log or a confirm dialog.
export function reattributionLine(c) {
  const who =
    c.kind === 'claimed' ? `nobody → ${c.to}` : c.kind === 'released' ? `${c.from} → nobody` : `${c.from} → ${c.to}`;
  const pts = Math.round((c.weekly_score || 0) * 100) / 100;
  return `${c.round} ${c.week} · ${c.player} (${c.type}, ${pts} pts): ${who}${c.contested ? ' [shared week]' : ''}`;
}
