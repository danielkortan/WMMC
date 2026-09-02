// ============================================================
// WMMC — Scoring-drift flags
// ============================================================
// The certified totals are summed from the weekly_* rollup rows, which are a derived cache of the
// daily rows plus each manager's add/drop windows. auditWeeklyRollupDrift (server.js) compares the
// two and reports where they disagree. This module is what happens to a finding AFTER it is made:
// how it is recorded on the season, when the alert repeats, and whether it may be certified over.
//
// It exists because the first version of that alert had none of this. It de-duplicated on an
// in-memory variable, so an unresolved drift posted to Slack ONCE and then went silent forever —
// and nothing was persisted, so "was this week ever flagged?" had no answer afterwards. SF Week 2
// sat drifted across twelve days of the 2026 semifinal on exactly that failure.
//
// Canonical copy. Mirrored verbatim in server.js (which cannot import an ES module) and guarded by
// tests/serverMirrors.test.js — every edit goes in both files.

// How long an unresolved drift may sit before the alert repeats. The audit runs twice a day (the
// 4am compile and the 7am post), so "post every run" would be spam — but a drift that does not
// change is the case that most needs chasing, not the case to fall silent on. So: quiet for a few
// days, then it comes back and says how long it has been there.
export const ROLLUP_DRIFT_NAG_DAYS = 3;

// Whole days between two ISO 'YYYY-MM-DD' dates (b - a). Both are date-only, so parsing them as
// UTC midnight avoids the off-by-one a local-time parse gives across a DST boundary.
export function daysBetweenISO(a, b) {
  if (!a || !b) return 0;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

// Record the current findings on the season, keyed `manager|week`, in the shape
// recordCorrectionFlags uses for refused corrections — and for the same reason. A drift that
// exists only as a Slack post cannot be asked about later, cannot be shown in the app, and cannot
// be checked at season close.
//
// The map is REPLACED each run rather than merged, so a drift that has been fixed clears itself
// the next time the audit runs clean — the same self-healing property the correction flags have.
// `first_seen` and `last_alerted` are carried across from the previous run, so the age of a
// standing problem is real and is not reset by a deploy or a restart.
export function recordRollupDriftFlags(sd, findings, todayISO) {
  const prev = sd && sd.rollup_drift && typeof sd.rollup_drift === 'object' ? sd.rollup_drift : {};
  const next = {};
  for (const f of findings || []) {
    const key = `${f.manager}|${f.week}`;
    const before = prev[key] || {};
    next[key] = {
      manager: f.manager,
      week: f.week,
      certified: f.certified,
      from_daily: f.from_daily,
      delta: f.delta,
      players: (f.players || []).slice(0, 6),
      first_seen: before.first_seen || todayISO,
      last_seen: todayISO,
      last_alerted: before.last_alerted || null,
      alerted_delta: Object.prototype.hasOwnProperty.call(before, 'alerted_delta') ? before.alerted_delta : null,
    };
  }
  if (Object.keys(next).length) sd.rollup_drift = next;
  else delete sd.rollup_drift;
  return next;
}

// Which stored flags to post about right now. Three ways to qualify: never posted, the number
// moved since it was last posted, or it has been quiet for `nagDays` and is still there. Anything
// already posted today is excluded, which is what keeps the 4am and 7am runs — and any manual
// re-run in between — from double-posting the same finding.
export function rollupDriftDueForAlert(flags, todayISO, nagDays = ROLLUP_DRIFT_NAG_DAYS) {
  return Object.values(flags || {}).filter((f) => {
    if (!f.last_alerted) return true;
    if (f.last_alerted === todayISO) return false;
    if (f.alerted_delta !== f.delta) return true;
    return daysBetweenISO(f.last_alerted, todayISO) >= nagDays;
  });
}

// The outstanding drift, as lines a human can read. Mirrors outstandingCorrectionFlags.
export function outstandingRollupDrift(sd) {
  return Object.values((sd && sd.rollup_drift) || {}).map((f) => ({
    manager: f.manager,
    week: f.week,
    delta: f.delta,
    certified: f.certified,
    from_daily: f.from_daily,
    first_seen: f.first_seen,
    last_seen: f.last_seen,
  }));
}

// Is a scoring disagreement standing in the way of certifying this season?
//
// The same gate, and the same argument, as correctionCloseBlock: a drifted week is one whose
// CERTIFIED scores the server itself says disagree with the stats underneath them, and a completed
// week's scores are what the bracket, the placements, the roasts, the recap and the permanent
// record are all computed from. The 2026 season closed on top of exactly this — 31.1 points
// credited to nobody across the semifinal that decided the Championship pairing.
//
// Blocks rather than warns, and takes `force`, because closing the season is a once-a-year
// irreversible-feeling action and the commissioner should have to say yes on purpose. Returns null
// when there is nothing in the way.
export function rollupDriftCloseBlock(sd, force) {
  const drift = outstandingRollupDrift(sd);
  if (!drift.length || force) return null;
  const lines = drift.map(
    (d) =>
      `${d.manager} ${d.week} (certified ${d.certified} vs ${d.from_daily} from the daily rows, ` +
      `off by ${Math.abs(d.delta)}, first seen ${d.first_seen || 'unknown'})`
  );
  return {
    error:
      `Cannot close the season — ${drift.length} manager-week(s) have certified totals that disagree with the ` +
      `stats they are derived from: ${lines.join('; ')}. Those weeks feed the bracket, the placements and the ` +
      `permanent record. Resolve them first (Rebuild Totals recompiles the rollups from the stored daily rows; ` +
      `if it persists, check the named player's add/drop dates against that week), or re-run with force to ` +
      `close anyway.`,
    rollup_drift: drift,
    force_required: true,
  };
}
