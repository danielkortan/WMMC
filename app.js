// ============================================================
// WMMC - The Whit Merrifield Memorial Cup
// Multi-season app with Commissioner management
// ============================================================

let DATA = null; // Data for the currently viewed season
const CURRENT_YEAR = new Date().getFullYear();
let SELECTED_SEASON = null;
let COMMISSIONER_EMAIL = null;
let LOGGED_IN_EMAIL = null;
let pendingSwapPollTimer = null;
let BANNER_BG_CONFIG = null; // Custom banner background config { imageData, posX, posY, scale }

// Google Sign-In Client ID — fetched at startup from GET /api/auth/config, which
// reads it from the server's GOOGLE_CLIENT_ID env var. When set, the Google button
// renders; the credential it returns is verified server-side by /api/auth/google,
// which issues a per-manager auth token that apiFetch then sends like a password —
// so Google users get full access (swaps, commissioner) just like password users.
let GOOGLE_CLIENT_ID = '';

// ============================================================
// Authenticated fetch
// ============================================================
// apiFetch wraps fetch() and injects X-User-Email + X-User-Password headers
// from the credentials saved at login. Use it for any call to a server route
// guarded by requireAuth / requireCommissioner middleware.
async function apiFetch(url, options = {}) {
  const email = LOGGED_IN_EMAIL || localStorage.getItem('wmmc_logged_in_email') || '';
  const password = localStorage.getItem('wmmc_logged_in_password') || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    'X-User-Email': email,
    'X-User-Password': password,
  };
  const resp = await fetch(url, { ...options, headers });
  // A 401 means cached creds are stale (commissioner role revoked, password
  // changed, etc.) — force re-login. But ONLY when we actually sent credentials:
  // a 401 on an unauthenticated/background call (e.g. the pre-login bootstrap POST)
  // must not reload, or it loops indefinitely.
  if (resp.status === 401 && email && password) {
    localStorage.removeItem('wmmc_logged_in_email');
    localStorage.removeItem('wmmc_logged_in_password');
    window.location.reload();
  }
  return resp;
}

// ============================================================
// Theme (light / dark) — global, persisted per account
// ============================================================
// Default is light. The locally cached value (wmmc_theme) is applied before
// first paint by the inline script in index.html; once logged in, the account
// preference (manager.theme from /api/managers) becomes authoritative.
function getStoredTheme() {
  try {
    return localStorage.getItem('wmmc_theme') === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('theme-dark', dark);
  try {
    localStorage.setItem('wmmc_theme', dark ? 'dark' : 'light');
  } catch (e) {
    /* localStorage unavailable — DOM class still applied */
  }
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = dark ? 'Light Mode' : 'Dark Mode';
}

async function persistTheme(theme) {
  if (!LOGGED_IN_EMAIL) return;
  try {
    await apiFetch(`/api/managers/${encodeURIComponent(LOGGED_IN_EMAIL)}/theme`, {
      method: 'POST',
      body: JSON.stringify({ theme }),
    });
  } catch (e) {
    /* best-effort — the local copy is already applied and cached */
  }
}

// SCORING and SEASON_SCHEDULE live in js/scoring.js (loaded via window
// globals by js/index.js). Server-side copies are kept in sync in server.js.

// ============================================================
// Schedule date helpers
// ============================================================

// Compute Mon–Sun date ranges for all 16 weeks from the ASG date.
// PP1 (5 wks) → PP2 (5 wks) → ASG break → QF (2) → SF (2) → Finals (2)
function computeScheduleDates(asgDateStr) {
  const asg = new Date(asgDateStr + 'T12:00:00');
  // Find Monday of ASG week (or prior Monday)
  const day = asg.getDay(); // 0=Sun … 6=Sat
  const asgMonday = new Date(asg);
  asgMonday.setDate(asg.getDate() - ((day + 6) % 7));

  // Week 1 starts 10 weeks before ASG Monday
  const week1Start = new Date(asgMonday);
  week1Start.setDate(asgMonday.getDate() - 70);

  const weeks = [];
  const cur = new Date(week1Start);

  // PP1 (5 weeks) + PP2 (5 weeks) = 10 weeks before break
  for (let i = 0; i < 10; i++) {
    const start = new Date(cur);
    const end = new Date(cur);
    end.setDate(end.getDate() + 6);
    weeks.push({ start: fmtDateISO(start), end: fmtDateISO(end) });
    cur.setDate(cur.getDate() + 7);
  }

  // Skip ASG break week
  cur.setDate(cur.getDate() + 7);

  // QF (2) + SF (2) + Finals (2) = 6 weeks after break
  for (let i = 0; i < 6; i++) {
    const start = new Date(cur);
    const end = new Date(cur);
    end.setDate(end.getDate() + 6);
    weeks.push({ start: fmtDateISO(start), end: fmtDateISO(end) });
    cur.setDate(cur.getDate() + 7);
  }

  return weeks; // 16 entries: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
}

// fmtDateISO lives in js/utils.js (loaded via window globals by js/index.js).

// Shift an ISO date string by N days: shiftDateISO('2026-07-12', 1) → '2026-07-13'.
function shiftDateISO(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return fmtDateISO(d);
}

// The skipped days between two rounds' schedule windows (e.g. the All-Star
// break week between PP2 Week 5 and QF Week 1). Returns {start, end, label}
// when at least one full day separates prevWeek.end from nextWeek.start,
// else null. The schedule stores no explicit break entry — the break IS the
// gap (computeScheduleDates skips the ASG week), so displays derive it.
function interRoundBreak(prevWeek, nextWeek, prevRound, nextRound) {
  if (!prevWeek || !nextWeek || !prevWeek.end || !nextWeek.start) return null;
  const start = shiftDateISO(prevWeek.end, 1);
  if (nextWeek.start <= start) return null;
  return {
    start,
    end: shiftDateISO(nextWeek.start, -1),
    label: prevRound === 'PP2' && nextRound === 'QF' ? 'All-Star Break' : 'League Break',
  };
}

// Short display:  "May 5 – 11" or "Jun 30 – Jul 6"
function fmtShortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${mo[d.getMonth()]} ${d.getDate()}`;
}

function fmtSlashDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDateRangeShort(startStr, endStr) {
  const s = new Date(startStr + 'T12:00:00');
  const e = new Date(endStr + 'T12:00:00');
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (s.getMonth() === e.getMonth()) {
    return `${mo[s.getMonth()]} ${s.getDate()} – ${e.getDate()}`;
  }
  return `${mo[s.getMonth()]} ${s.getDate()} – ${mo[e.getMonth()]} ${e.getDate()}`;
}

// ---- Submission Period Deadline Helpers ----
// Each period has a "first game" time stored in sd.period_deadlines[period].
// The submission edit deadline is 5 minutes before that first game.

const PERIOD_LABELS = {
  pp1: 'Pool Play 1',
  pp2: 'Pool Play 2',
  qf: 'Quarterfinals',
  sf: 'Semifinals',
  finals: 'Finals',
};

// Returns a Date for when a period's submission window opens, or null (= open from season start)
//
// Every period's window opens the Friday before its Week 1 starts (3 days before the
// Monday start), including PP1 — once the commissioner has set the schedule. PP1 closes
// at its first games like the rest (see getPeriodFirstGame), so the initial-submission
// form is no longer editable/submittable after PP1 has begun. An unknown period returns
// null (= open from season start).
const PERIOD_OPEN_ROUND = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };

function getPeriodOpenDate(sd, period) {
  const dates = sd && sd.schedule_dates;
  if (!dates) return null;
  const round = PERIOD_OPEN_ROUND[period];
  if (!round) return null; // pp1 / unknown: open from season start
  const idx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === 'Week 1');
  if (idx < 0 || !dates[idx]) return null;
  const d = new Date(dates[idx].start + 'T00:00:00');
  d.setDate(d.getDate() - 3); // Friday before the Monday start
  return d;
}

// Round each submission period maps to, for deriving its first-games date from the schedule.
const PERIOD_FIRST_GAME_ROUND = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };

// Estimated first-game (first-pitch) time per period. Explicit `period_deadlines[period]`
// (set by the commissioner, or auto-filled from the MLB Stats API) always wins; these are the
// fallback the autofill uses when the API is unavailable, and the time-of-day getPeriodFirstGame
// applies to the schedule date when no explicit deadline is stored. Verify against the MLB
// schedule before each season — the dates are season-specific, only the evening time-of-day is
// reused as a sane default.
const PERIOD_DEADLINE_DEFAULTS = {
  pp1: '2026-05-04T17:40', // May 4  — earliest game 5:40 PM ET (Braves/Mariners)
  pp2: '2026-06-08T18:35', // June 8 — estimated; verify against MLB schedule
  qf: '2026-07-20T19:05', // July 20 — 7:05 PM ET (Pirates @ Yankees)
  sf: '2026-08-03T20:05', // Aug 3  — 8:05 PM ET (Dodgers @ Cubs)
  finals: '2026-08-17T19:00', // Aug 17 — 7:00 PM ET (ESPN: Tigers @ Pirates)
};

// Returns a Date for the first MLB game of a period. Prefers an explicitly configured
// first-game time (sd.period_deadlines[period]); otherwise falls back to the period's first
// scheduled day, so a submission stays editable right up until that period's first games even
// when no explicit deadline was set. Null when neither exists.
function getPeriodFirstGame(sd, period) {
  const val = sd && sd.period_deadlines && sd.period_deadlines[period];
  if (val) return new Date(val);
  const dates = sd && sd.schedule_dates;
  const round = PERIOD_FIRST_GAME_ROUND[period];
  if (!dates || !round) return null;
  const idx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === 'Week 1');
  if (idx < 0 || !dates[idx] || !dates[idx].start) return null;
  // No explicit first-game time stored. Fall back to the period's first scheduled day at a
  // realistic first-pitch time of day — NOT midnight. Midnight (T00:00:00) would put the
  // deadline (first game − 5 min) at 23:55 the *night before*, closing the window ~a full day
  // before games actually start. Use the period's default first-pitch time-of-day applied to
  // the authoritative schedule date; an explicit period_deadlines[period] still wins above.
  const def = PERIOD_DEADLINE_DEFAULTS[period];
  const timeOfDay = def && def.includes('T') ? def.slice(def.indexOf('T')) : 'T00:00:00';
  return new Date(dates[idx].start + timeOfDay);
}

// Returns the submission deadline Date (first game − 5 min) for a period, or null
function getPeriodDeadline(sd, period) {
  const fg = getPeriodFirstGame(sd, period);
  return fg ? new Date(fg.getTime() - 5 * 60 * 1000) : null;
}

// Returns true if the submission/edit window for a period is currently open (time only, no qualification check)
function isPeriodTimeOpen(sd, period) {
  const now = Date.now();
  const openDate = getPeriodOpenDate(sd, period);
  if (openDate && now < openDate.getTime()) return false;
  const deadline = getPeriodDeadline(sd, period);
  // If no deadline is configured, treat the window as open (no restriction yet)
  return !deadline || now < deadline.getTime();
}

// Stricter than isPeriodTimeOpen: returns true only when we can confirm the window
// has actually opened — i.e. the period's open date is known AND has passed (and its
// deadline, if known, hasn't). Unlike isPeriodTimeOpen, an unconfigured/unknown open
// date counts as "not open" rather than "no restriction yet". Used by the reminder
// banner so it never nags about a period whose schedule the commissioner hasn't set.
function isPeriodWindowConfirmedOpen(sd, period) {
  const openDate = getPeriodOpenDate(sd, period);
  if (!openDate || Date.now() < openDate.getTime()) return false;
  const deadline = getPeriodDeadline(sd, period);
  return !deadline || Date.now() < deadline.getTime();
}

// ---- Playoff Qualification Helpers ----

// Returns array of up to 8 QF qualifier names based on PP1+PP2 scores (or null if pools not configured)
// ---- Canonical pool-play seeding (single source of truth) ----
// Scores every manager's PP1/PP2 batting & pitching via managerWeekSubtotal — the same
// drop-aware path the scoreboard tables and My Roster use — so dropped players never inflate
// a pool total and the scoreboard, the tentative bracket, and qualification can't disagree.
//
// Rules (per the commissioner):
//   - Per pool: highest PP1 score = PP1 leader, highest PP2 score = PP2 leader (a manager can
//     win both). Unique leaders auto-qualify.
//   - Wildcards: highest combined-total non-leaders, filling the bracket to bracketSize (8).
//   - Seeds: ALL pool winners first (ranked by total), THEN wildcards (ranked by total).
//   - Tiebreaker when totals are equal: periods won -> batting -> pitching -> PP2 -> PP1.
//
// Returns null when no pools are configured. Otherwise an object with seeds (ordered entries),
// byManager, pp1Leaders, pp2Leaders, allLeaders, wildcardSet, and qualifierNames. Each entry
// carries manager, pool, pp1/pp2, batting, pitching, total, periodsWon, isPP1Leader,
// isPP2Leader, isPoolWinner, isWildcard, seed.
function computePoolPlaySeeding(seasonData, bracketSize = 8) {
  const managers = getManagers().filter((m) => m.active !== false && m.pool);
  if (managers.length === 0) return null;

  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const entries = managers.map((m) => ({ manager: m.name, pool: m.pool, pp1Bat: 0, pp1Pit: 0, pp2Bat: 0, pp2Pit: 0 }));
  const byName = new Map(entries.map((e) => [e.manager, e]));

  // Sum per-period batting/pitching through managerWeekSubtotal (drop-aware eligibility,
  // identical to the scoreboard tables) so seeding scores match what managers see.
  SEASON_SCHEDULE.forEach((schedWeek, idx) => {
    if (schedWeek.round !== 'PP1' && schedWeek.round !== 'PP2') return;
    managers.forEach((m) => {
      const bat = managerWeekSubtotal(seasonData, m.name, schedWeek, idx, batting, 'batter', 'batters');
      const pit = managerWeekSubtotal(seasonData, m.name, schedWeek, idx, pitching, 'pitcher', 'pitchers');
      const e = byName.get(m.name);
      if (schedWeek.round === 'PP1') {
        e.pp1Bat += bat;
        e.pp1Pit += pit;
      } else {
        e.pp2Bat += bat;
        e.pp2Pit += pit;
      }
    });
  });

  // The seeding RULE itself lives in js/seeding.js so the What If bracket and the real bracket
  // can never disagree about it (see CLAUDE.md: no duplicated logic between app.js and js/).
  return seedFromPeriodTotals(entries, { bracketSize });
}

// Authoritative seeding for a season. Once pool play is finalized the commissioner-confirmed
// snapshot (taken at "End Pool Play") is locked in — so a later pool-play stat correction can't
// silently reseed an in-progress playoff. Before finalization it's the live prediction. Falls
// back to the live computation for any finalized season that predates the snapshot field.
function getSeeding(sd) {
  const snap = sd && sd.confirmed_seeding;
  if (snap && Array.isArray(snap.qualifierNames) && (sd.finalized_rounds || []).includes('PP')) {
    return {
      qualifierNames: snap.qualifierNames,
      pp1Leaders: new Set(snap.pp1Leaders || []),
      pp2Leaders: new Set(snap.pp2Leaders || []),
      allLeaders: new Set([...(snap.pp1Leaders || []), ...(snap.pp2Leaders || [])]),
      wildcardSet: new Set(snap.wildcards || []),
      seeds: snap.qualifierNames.map((name, i) => ({ manager: name, seed: i + 1 })),
      fromSnapshot: true,
    };
  }
  return computePoolPlaySeeding(sd);
}

// Build the JSON-serializable seeding snapshot stored at "End Pool Play".
function buildSeedingSnapshot(sd) {
  const seeding = computePoolPlaySeeding(sd);
  if (!seeding) return null;
  return {
    qualifierNames: seeding.qualifierNames,
    pp1Leaders: [...seeding.pp1Leaders],
    pp2Leaders: [...seeding.pp2Leaders],
    wildcards: [...seeding.wildcardSet],
  };
}

// Ordered QF qualifier names (seeds 1..8), or null if pools aren't configured. Thin wrapper
// over the authoritative seeding so every consumer agrees.
function getQFQualifiers(sd) {
  const seeding = getSeeding(sd);
  if (!seeding || seeding.qualifierNames.length === 0) return null;
  return seeding.qualifierNames;
}

// Drop-aware round-score breakdown {bat, pit, total} for a manager in a playoff round
// (QF/SF/Finals), attributed exactly like every other score in the app (via weeklyRowOwner).
function roundBreakdown(sd, manager, round, rosterLookup, weekKeyToStart) {
  const rl = rosterLookup || buildRosterLookup(sd);
  const wk = weekKeyToStart || buildWeekKeyToStart();
  let bat = 0,
    pit = 0;
  (sd.weekly_batting || []).forEach((b) => {
    if (b.round === round && weeklyRowOwner(sd, rl, wk, b, 'batter') === manager) bat += b.weekly_score || 0;
  });
  (sd.weekly_pitching || []).forEach((p) => {
    if (p.round === round && weeklyRowOwner(sd, rl, wk, p, 'pitcher') === manager) pit += p.weekly_score || 0;
  });
  bat = Math.round(bat * 100) / 100;
  pit = Math.round(pit * 100) / 100;
  return { bat, pit, total: Math.round((bat + pit) * 100) / 100 };
}

// Seed rank (1 = best) from the canonical seeding, used to break playoff ties by the same
// hierarchy that decides seeding (total -> periods won -> batting -> pitching -> PP2 -> PP1).
function seedRankLookup(sd) {
  const seeding = getSeeding(sd);
  const rank = {};
  if (seeding) seeding.seeds.forEach((s) => (rank[s.manager] = s.seed));
  return rank;
}

// Winner of a head-to-head playoff matchup: higher round total wins; a tie goes to the better
// seed (whose seeding already reflects the tiebreaker hierarchy).
function roundMatchupWinner(aName, aTotal, bName, bTotal, seedRank) {
  if (aTotal !== bTotal) return aTotal > bTotal ? aName : bName;
  return (seedRank[aName] ?? Infinity) <= (seedRank[bName] ?? Infinity) ? aName : bName;
}

// Returns array of SF participant names (QF winners), or null if QF not finalized
function getSFParticipants(sd) {
  const qf = getQFQualifiers(sd);
  if (!qf || qf.length < 8) return null;
  if (!(sd.finalized_rounds || []).includes('QF')) return null;
  const rosterLookup = buildRosterLookup(sd);
  const weekKeyToStart = buildWeekKeyToStart();
  const seedRank = seedRankLookup(sd);
  const win = (a, b) =>
    roundMatchupWinner(
      a,
      roundBreakdown(sd, a, 'QF', rosterLookup, weekKeyToStart).total,
      b,
      roundBreakdown(sd, b, 'QF', rosterLookup, weekKeyToStart).total,
      seedRank
    );
  return [
    [qf[0], qf[7]],
    [qf[3], qf[4]],
    [qf[2], qf[5]],
    [qf[1], qf[6]],
  ].map(([a, b]) => win(a, b));
}

// Returns array of Finals participant names (SF winners), or null if SF not finalized
function getFinalsParticipants(sd) {
  const sf = getSFParticipants(sd);
  if (!sf || sf.length < 4) return null;
  if (!(sd.finalized_rounds || []).includes('SF')) return null;
  const rosterLookup = buildRosterLookup(sd);
  const weekKeyToStart = buildWeekKeyToStart();
  const seedRank = seedRankLookup(sd);
  const win = (a, b) =>
    roundMatchupWinner(
      a,
      roundBreakdown(sd, a, 'SF', rosterLookup, weekKeyToStart).total,
      b,
      roundBreakdown(sd, b, 'SF', rosterLookup, weekKeyToStart).total,
      seedRank
    );
  return [
    [sf[0], sf[1]],
    [sf[2], sf[3]],
  ].map(([a, b]) => win(a, b));
}

// Head-to-head matchup pairs for a playoff round, in bracket display order — the same
// structure the Playoff Bracket card renders (QF1 1v8, QF4 4v5, QF3 3v6, QF2 2v7; SF from
// QF winners; Championship + 3rd Place from SF winners/losers). Returns
// [{ label, teams: [{ name, seed }, { name, seed }] }] or null when the round's
// participants aren't determined yet (no 8-manager seeding, or the prior round isn't
// finalized) — callers fall back to a plain standings view.
function playoffRoundMatchups(sd, round) {
  if (!sd) return null;
  const qualifiers = getQFQualifiers(sd);
  if (!qualifiers || qualifiers.length < 8) return null;
  const seedOf = {};
  qualifiers.slice(0, 8).forEach((n, i) => (seedOf[n] = i + 1));
  const mk = (label, a, b) => ({
    label,
    teams: [
      { name: a, seed: seedOf[a] || null },
      { name: b, seed: seedOf[b] || null },
    ],
  });
  if (round === 'QF') {
    const q = qualifiers;
    return [mk('QF1', q[0], q[7]), mk('QF4', q[3], q[4]), mk('QF3', q[2], q[5]), mk('QF2', q[1], q[6])];
  }
  if (round === 'SF') {
    const sf = getSFParticipants(sd);
    if (!sf || sf.length < 4) return null;
    return [mk('SF1', sf[0], sf[1]), mk('SF2', sf[2], sf[3])];
  }
  if (round === 'Finals') {
    const sf = getSFParticipants(sd);
    const fin = getFinalsParticipants(sd);
    if (!sf || !fin || fin.length < 2) return null;
    const losers = [sf[0] === fin[0] ? sf[1] : sf[0], sf[2] === fin[1] ? sf[3] : sf[2]];
    return [mk('Championship', fin[0], fin[1]), mk('3rd Place', losers[0], losers[1])];
  }
  return null;
}

// Returns true if a manager is qualified for a given period (all managers qualify for pp1/pp2)
function isManagerQualifiedForPeriod(managerName, period, sd) {
  if (period === 'pp1' || period === 'pp2') return true;
  if (period === 'qf') {
    const q = getQFQualifiers(sd);
    return q ? q.includes(managerName) : false;
  }
  // SF and Finals submission cards are shown to all managers; the commissioner's
  // "dump losers" action removes non-advancing rosters after each round closes.
  if (period === 'sf' || period === 'finals') return true;
  return false;
}

// The schedule round a period's submission is for. The Finals period covers BOTH Finals-week
// games — the Championship and the 3rd-place game — which is why all four semifinalists submit
// for it (see isManagerEliminatedForPeriod).
const PERIOD_SUBMISSION_ROUND = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };

// Is this manager's season already over before `period` starts? The rule itself is the shared
// one in js/eligibility.js (mirrored in server.js), reached here on `window` — so the submission
// card, the submission-warning banner and the server all read the same ladder rather than three
// copies of a hardcoded round list. In particular: a manager who lost the SEMIFINAL is NOT
// finished — they play the 3rd-place game over the Finals weeks, and need a Finals roster.
function isManagerEliminatedForPeriod(sd, managerName, period) {
  const elim = sd && sd.eliminated && sd.eliminated[managerName];
  if (!elim) return false;
  const round = PERIOD_SUBMISSION_ROUND[period];
  return !!round && !isManagerActiveInRound(round, elim);
}

// The Finals period's two-game field: the Championship pair (SF winners) and, with the four
// semifinalists, the 3rd-place pair. Both are null until the semifinals are finalized. Derived
// once per caller because each read runs the bracket.
function finalsGameField(sd) {
  if (!sd) return { finalists: null, semifinalists: null };
  return { finalists: getFinalsParticipants(sd), semifinalists: getSFParticipants(sd) };
}

// What to call a submission period ON ONE MANAGER'S CARD. Every period but the Finals is the
// same game for everybody. The Finals period is two — the Championship and the 3rd-place game,
// played over the same two weeks by all four semifinalists — so a manager who lost his semifinal
// was being told to submit a "Finals" roster for a game he isn't in. Name his actual game; the
// rule is js/eligibility.js's finalsGameLabel, which falls back to naming both when the
// semifinals aren't finalized yet. Pass `field` when rendering several managers in one pass.
function submissionPeriodLabel(sd, period, managerName, field = null) {
  const base = PERIOD_LABELS[period] || period;
  if (period !== 'finals') return base;
  return finalsGameLabel(managerName, field || finalsGameField(sd));
}

// What to call it on a surface that spans MANAGERS (a commissioner's approval queue, the
// submission status table) — there, the period really is both games.
function periodLabelForAll(period) {
  return period === 'finals' ? FINALS_GAME_LABELS.unknown : PERIOD_LABELS[period] || period;
}

// The label for one of `manager`'s periods, read straight off the selected season — for the
// confirm/alert strings, which have a manager and a period and nothing else in hand.
function periodLabelForManager(period, manager) {
  const seasons = getSeasons();
  return submissionPeriodLabel(seasons[SELECTED_SEASON], period, manager);
}

// ---- Period Submission Data Helpers ----

function getPeriodSub(sd, period, manager) {
  if (period === 'pp1') return sd.initial_submissions && sd.initial_submissions[manager];
  return sd.period_submissions && sd.period_submissions[period] && sd.period_submissions[period][manager];
}

function ensurePeriodSub(sd, period, manager) {
  if (period === 'pp1') {
    if (!sd.initial_submissions) sd.initial_submissions = {};
    if (!sd.initial_submissions[manager]) {
      sd.initial_submissions[manager] = { batters: [], pitchers: [], status: 'draft' };
    }
    return sd.initial_submissions[manager];
  }
  if (!sd.period_submissions) sd.period_submissions = {};
  if (!sd.period_submissions[period]) sd.period_submissions[period] = {};
  if (!sd.period_submissions[period][manager]) {
    sd.period_submissions[period][manager] = { batters: [], pitchers: [], status: 'draft' };
  }
  return sd.period_submissions[period][manager];
}

// Get schedule_dates array for the selected season (or null)
function getScheduleDates() {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  return (sd && sd.schedule_dates) || null;
}

// Look up week index from a round|week key
function weekIndexFromKey(round, week) {
  return SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
}

// Start date of the PERIOD (round) a week belongs to — the schedule start of that round's first
// week. Used to scope add/drop carry-forward to within a period so a prior period's players don't
// leak into a new submission period (PP2/QF/SF/Finals). Returns null for the initial period (PP1),
// leaving its behavior unchanged.
//
// The rule itself lives in js/eligibility.js (canonical, unit-tested) and reaches us on `window`
// via js/index.js; this is only the season-shaped adapter for it, so app.js is no longer a third
// implementation alongside that copy and the server's.
function periodStartForSeason(seasonData, round) {
  return periodStartForRound(round, SEASON_SCHEDULE, (seasonData && seasonData.schedule_dates) || []);
}

// Determine the current scoring period from loaded stats data
function getCurrentScoringPeriod(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  // Collect all unique round|week combinations that have data
  const weekKeys = new Set();
  batting.forEach((b) => {
    if (b.round && b.week) weekKeys.add(`${b.round}|${b.week}`);
  });
  pitching.forEach((p) => {
    if (p.round && p.week) weekKeys.add(`${p.round}|${p.week}`);
  });

  if (weekKeys.size === 0) return null;

  // Normalize round variants (PP1P → PP1, PP2P → PP2)
  const normalizeRound = (r) => r.replace(/P$/, '');

  // Find the latest week by schedule index
  let latestIdx = -1;
  let latestRound = null;
  let latestWeek = null;

  weekKeys.forEach((key) => {
    const [round, week] = key.split('|');
    const normRound = normalizeRound(round);
    const idx = weekIndexFromKey(normRound, week);
    if (idx > latestIdx) {
      latestIdx = idx;
      latestRound = normRound;
      latestWeek = week;
    }
  });

  if (latestIdx < 0) return null;

  const dates = getScheduleDates();

  // Sync to the current calendar week (ET). If today falls inside a scheduled
  // week, that week wins over the latest data week in BOTH directions: cap
  // back when data was partially written for a future week via live-sync or
  // early import, and advance forward when a new week has started but its
  // stats haven't synced yet — e.g. QF Week 1 right after the All-Star break,
  // when the latest data week is still PP2 Week 5.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (dates) {
    for (let i = 0; i < dates.length && i < SEASON_SCHEDULE.length; i++) {
      const d = dates[i];
      if (d && d.start && d.end && todayET >= d.start && todayET <= d.end) {
        if (i !== latestIdx) {
          latestIdx = i;
          latestRound = SEASON_SCHEDULE[i].round;
          latestWeek = SEASON_SCHEDULE[i].week;
        }
        break;
      }
    }
  }

  const scheduleEntry = SEASON_SCHEDULE[latestIdx];
  const dateRange = dates && dates[latestIdx] ? dates[latestIdx] : null;

  // Round info
  const roundWeeks = SEASON_SCHEDULE.filter((s) => s.round === latestRound);
  const weekNum = parseInt(latestWeek.replace('Week ', ''));
  const totalRoundWeeks = roundWeeks.length;

  // Round overall date range
  let roundStartDate = null,
    roundEndDate = null;
  if (dates) {
    const roundIndices = SEASON_SCHEDULE.map((s, i) => (s.round === latestRound ? i : -1)).filter((i) => i >= 0);
    if (roundIndices.length > 0 && dates[roundIndices[0]] && dates[roundIndices[roundIndices.length - 1]]) {
      roundStartDate = dates[roundIndices[0]].start;
      roundEndDate = dates[roundIndices[roundIndices.length - 1]].end;
    }
  }

  return {
    round: latestRound,
    week: latestWeek,
    label: scheduleEntry.label,
    weekIndex: latestIdx,
    weekNum,
    totalRoundWeeks,
    dateRange,
    roundName: ROUND_DISPLAY_NAMES[latestRound] || latestRound,
    roundStartDate,
    roundEndDate,
  };
}

const ROUND_DISPLAY_NAMES = {
  PP1: 'Pool Play 1',
  PP2: 'Pool Play 2',
  QF: 'Quarterfinals',
  SF: 'Semifinals',
  Finals: 'Finals',
};

// When today (ET) falls in the gap between two rounds' schedule windows — e.g. the
// All-Star break week between PP2's last week and the Quarterfinals — return info
// about the break: the upcoming round, its start date, and its roster submission
// deadline (first game − 5 min, via getPeriodDeadline). Returns null whenever today
// is inside a scheduled week, before the season, after it, or in a same-round gap,
// so the normal "Round — Week N of M" banner keeps rendering in all of those cases.
function getBetweenPeriodsInfo(sd) {
  const dates = (sd && sd.schedule_dates) || [];
  if (!dates.length) return null;
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let prevIdx = -1;
  let nextIdx = -1;
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    const d = dates[i];
    if (!d || !d.start || !d.end) continue;
    if (todayET >= d.start && todayET <= d.end) return null; // inside a scheduled week
    if (d.end < todayET) prevIdx = i;
    if (nextIdx < 0 && d.start > todayET) nextIdx = i;
  }
  if (prevIdx < 0 || nextIdx < 0) return null; // preseason or season over
  const prevRound = SEASON_SCHEDULE[prevIdx].round;
  const nextRound = SEASON_SCHEDULE[nextIdx].round;
  if (prevRound === nextRound) return null; // gap within a round — not a period break
  return {
    prevRound,
    nextRound,
    nextRoundName: ROUND_DISPLAY_NAMES[nextRound] || nextRound,
    nextStart: dates[nextIdx].start,
    deadline: getPeriodDeadline(sd, nextRound.toLowerCase()),
    // The PP2 → QF gap is the league's All-Star break week by schedule design.
    isAllStarBreak: prevRound === 'PP2' && nextRound === 'QF',
  };
}

// ============================================================
// Weekly stat rows, bucketed by round|week and then by manager.
// ============================================================
// managerWeekSubtotal is called 256 times to score one scoreboard — 16 scheduled weeks x 8
// managers x batting/pitching — and each call used to walk the whole weekly array twice looking
// for its own week. Bucketing once per array turns those scans into a Map lookup. Row ORDER
// inside each bucket is the array's own order, so every derived list downstream is byte-identical
// to what the scans produced; this is a lookup change, not a scoring change.
//
// Legacy 'PP1P' / 'PP2P' import variants share weeks with their parent round, so they normalize
// onto the parent's key — the same rule the old inline matchesRoundWeek applied.
//
// Cached in a WeakMap on the rows array itself (the pattern _normTeamIndexCache already uses), so
// a fresh season parse — or any code that REPLACES sd.weekly_batting — silently gets a fresh
// index. A push changes `length` and rebuilds. The one case neither covers is replacing a row
// in situ at the same length, which is why editStat calls invalidateWeeklyRowIndex.
const _weeklyRowIndexCache = new WeakMap();
const EMPTY_WEEK_BUCKET = { rows: [], byManager: new Map() };

function parentRound(round) {
  return round && round.length > 1 && round.endsWith('P') ? round.slice(0, -1) : round;
}

function weeklyRowIndex(rowsArr) {
  if (!Array.isArray(rowsArr)) return null;
  const cached = _weeklyRowIndexCache.get(rowsArr);
  if (cached && cached.length === rowsArr.length) return cached.byWeek;

  const byWeek = new Map();
  for (const r of rowsArr) {
    if (!r || !r.week) continue;
    const key = `${parentRound(r.round)}|${r.week}`;
    let bucket = byWeek.get(key);
    if (!bucket) {
      bucket = { rows: [], byManager: new Map() };
      byWeek.set(key, bucket);
    }
    bucket.rows.push(r);
    if (r.manager) {
      const mine = bucket.byManager.get(r.manager);
      if (mine) mine.push(r);
      else bucket.byManager.set(r.manager, [r]);
    }
  }
  _weeklyRowIndexCache.set(rowsArr, { length: rowsArr.length, byWeek });
  return byWeek;
}

// Drop a cached index after a row is swapped out in place — the only mutation the length check
// cannot see.
function invalidateWeeklyRowIndex(rowsArr) {
  if (Array.isArray(rowsArr)) _weeklyRowIndexCache.delete(rowsArr);
}

// ============================================================
// Per-week subtotal for one manager. Single source of truth for the
// "what stats count toward this manager this week" question used by
// renderRosterData (the My Roster weekly listing), computeRosterPeriodScores
// (the Pool Play Total / PP1 / PP2 stat cards), the scoreboard's
// periodScores (Pool Play Scoreboard), and any future place that needs the
// same number. Mirrors renderRosterData's per-week pipeline exactly:
// wasDroppedBefore -> eligibility set -> manager/null dedup -> sum.
// ============================================================
function managerWeekSubtotal(seasonData, managerName, schedWeek, weekIdx, rowsArr, playerKey, listKey, detailOut) {
  if (!seasonData || !managerName) return 0;
  const round = schedWeek.round;
  const week = schedWeek.week;

  // Every row for this round+week (legacy 'PP1P'/'PP2P' folded in), looked up once instead of
  // scanning the whole weekly array twice per call. See weeklyRowIndex.
  const weekBucket = (weeklyRowIndex(rowsArr) || new Map()).get(`${parentRound(round)}|${week}`) || EMPTY_WEEK_BUCKET;

  // WHO this manager held, and for which days — one derivation, shared with the server through
  // js/rosterWindows.js. This replaced a union of five heuristics (the roster array filtered by a
  // was-he-dropped-earlier scan, a period-scoped carry-forward, this week's date bucket, and the
  // approved swaps whose week_key matched) that the server had its own slightly different copy of.
  // 43 of the 98 entries in MEMORY.md were the two disagreeing. See MEMORY.md 2026-09-02.
  const weekDates = (seasonData.schedule_dates || [])[weekIdx] || {};
  const windows = weekRosterWindows({
    weekStart: weekDates.start || null,
    weekEnd: weekDates.end || null,
    periodStart: periodStartForSeason(seasonData, round),
    mgrDates: (seasonData.roster_dates || {})[managerName] || {},
    rosterArray: ((seasonData.rosters || {})[managerName] || {})[`${round}|${week}`] || {},
  });

  // One row per player. A dual-source sync can leave two; prefer the one already attributed to this
  // manager. A row attributed to ANOTHER manager still counts here when the windows say this manager
  // held him — `manager` is a sticky derived cache naming whoever held him at compile time, so it
  // cannot arbitrate a week the player changed hands in. rowScore reads the split for those.
  const byPlayer = new Map();
  for (const r of weekBucket.rows) {
    if (!windows[r[playerKey]]) continue;
    const existing = byPlayer.get(r[playerKey]);
    if (!existing || (r.manager === managerName && existing.manager !== managerName)) {
      byPlayer.set(r[playerKey], r);
    }
  }

  if (detailOut) {
    // Per-player points for this week, restricted to players of this type: the windows span both
    // lists, so include a player only when he has a row of this type or sits in this type's roster
    // array. The scores still sum to the returned subtotal — array-only players contribute 0.
    const typeRoster = new Set(
      (((seasonData.rosters || {})[managerName] || {})[`${round}|${week}`] || {})[listKey] || []
    );
    for (const player of Object.keys(windows)) {
      const row = byPlayer.get(player);
      if (row) detailOut.push({ player, score: rowScore(row, managerName) });
      else if (typeRoster.has(player)) detailOut.push({ player, score: 0 });
    }
  }

  let total = 0;
  for (const row of byPlayer.values()) total += rowScore(row, managerName);
  return total;
}

// What ONE manager earned from ONE weekly stat row. Normally the row's stored weekly_score — but a
// player held by two managers inside one week (a mid-week trade) has a single row covering both
// their windows, so the compile stores the per-manager split on it. Mirrors managerRowScoreForWeek
// in server.js; the client is not sent daily rows, so it reads the split rather than re-deriving it.
function rowScore(row, managerName) {
  if (row.manager_scores && Object.prototype.hasOwnProperty.call(row.manager_scores, managerName)) {
    return row.manager_scores[managerName] || 0;
  }
  return row.weekly_score || 0;
}

// ============================================================
// Player display helper — shows "Juan Soto (NYM)" when team data exists
// ============================================================
// Normalized-name → team index per team-map object, so the fallback lookup is
// O(1) per call. WeakMap-keyed on the map object: a fresh season parse gets a
// fresh index automatically.
const _normTeamIndexCache = new WeakMap();
function _normTeamLookup(map, normKey) {
  if (!map) return null;
  let idx = _normTeamIndexCache.get(map);
  if (!idx) {
    idx = new Map();
    for (const [n, t] of Object.entries(map)) {
      const k = normalizeName(n);
      if (!k) continue;
      // Two entries that normalize alike but disagree on team (e.g. the two
      // Max Muncys) are ambiguous — never guess a team from them.
      if (idx.has(k) && idx.get(k) !== t) idx.set(k, null);
      else idx.set(k, t);
    }
    _normTeamIndexCache.set(map, idx);
  }
  return idx.get(normKey) || null;
}

function displayPlayer(name, sd) {
  if (!name) return '';
  let team = (sd && sd.batters_team && sd.batters_team[name]) || (sd && sd.pitchers_team && sd.pitchers_team[name]);
  if (!team && sd) {
    // Roster strings can differ from the team-map key in accents/punctuation
    // ("Ronald Acuna Jr." vs MLB's "Ronald Acuña Jr.") — fall back to a
    // normalized lookup so the scoreboard still shows the team.
    const normKey = normalizeName(name);
    team = _normTeamLookup(sd.batters_team, normKey) || _normTeamLookup(sd.pitchers_team, normKey);
  }
  if (!team || name.endsWith(`(${team})`)) return esc(name);
  return `${esc(name)} (${esc(team)})`;
}

// ============================================================
// Data helpers (in-memory cache, localStorage mirror + server persistence)
// ============================================================
// The seasons/managers caches are held in memory as JSON strings and only MIRRORED to
// localStorage. localStorage has a hard per-site quota (~5MB); once the season blob outgrew it,
// every setItem threw, and the old code (which read straight from localStorage) silently fell
// back to whatever stale copy each device last managed to store — so every browser showed a
// different frozen scoreboard, and a fresh browser showed nothing. The in-memory string is the
// session's source of truth: it always accepts fresh server data, even when localStorage can't
// hold it. The localStorage mirror only seeds the next page load if the server is unreachable.
let SEASONS_JSON = null;
let MANAGERS_JSON = null;

function readSeasonsJSON() {
  if (SEASONS_JSON == null) {
    try {
      SEASONS_JSON = localStorage.getItem('wmmc_seasons') || '{}';
    } catch (_) {
      SEASONS_JSON = '{}';
    }
  }
  return SEASONS_JSON;
}

// ---- On-demand daily stats ----
// Daily stat rows (daily_batting/daily_pitching) no longer ride GET /api/seasons — they are the
// largest field, grow every game day, and scoring reads weekly rows. The two views that display
// daily data (Trends charts, the per-week roster's date-windowed stat tables) pull them from
// GET /api/seasons/:year/daily-stats via this cache instead. Sync read + async fill: render
// immediately with whatever is cached (both views already degrade gracefully without daily
// rows), then re-render once when the fetch lands.
let DAILY_STATS_CACHE = {}; // { [year]: { batting: [], pitching: [] } }
const DAILY_STATS_PENDING = {};

function getDailyStatsCached(year) {
  return DAILY_STATS_CACHE[year] || null;
}

function ensureDailyStats(year, onLoaded) {
  if (DAILY_STATS_CACHE[year] || DAILY_STATS_PENDING[year]) return;
  DAILY_STATS_PENDING[year] = true;
  fetch(`/api/seasons/${year}/daily-stats`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d) => {
      DAILY_STATS_CACHE[year] = { batting: d.batting || [], pitching: d.pitching || [] };
      delete DAILY_STATS_PENDING[year];
      if (onLoaded) onLoaded();
    })
    .catch((e) => {
      // Not cached — the next render retries. Views fall back to weekly totals meanwhile.
      delete DAILY_STATS_PENDING[year];
      console.warn('daily-stats fetch failed:', e.message);
    });
}

// Accepts the seasons object or its pre-stringified JSON. Never throws — a quota failure on the
// localStorage mirror must not abort the caller (that's the bug this layer exists to fix).
function setSeasonsLocal(seasonsOrJson) {
  const json = typeof seasonsOrJson === 'string' ? seasonsOrJson : JSON.stringify(seasonsOrJson);
  // Season data changed (a sync writes weekly + daily together) — invalidate the daily cache so
  // the daily views refetch. Cheap false positives (roster-only saves) just cause a revalidated
  // (ETag/304) refetch on the next Trends/My-Roster render.
  if (SEASONS_JSON !== json) DAILY_STATS_CACHE = {};
  SEASONS_JSON = json;
  try {
    localStorage.setItem('wmmc_seasons', json);
  } catch (_) {
    // Quota exceeded. Drop the old mirror (a stale mirror is what froze devices on different
    // vintages of the scoreboard) and retry once — removing the old value frees its quota.
    try {
      localStorage.removeItem('wmmc_seasons');
      localStorage.setItem('wmmc_seasons', json);
    } catch (e) {
      console.warn('wmmc_seasons localStorage mirror failed (quota?) — using in-memory data:', e.message);
    }
  }
}

function getSeasons() {
  return JSON.parse(readSeasonsJSON());
}
// Persist a season to the server. The payload carries the `_rev` token the client loaded from
// GET /api/seasons; the server rejects the save with 409 if that token is stale (another save/sync
// changed the data, or it's a tab on old JS with no token), which means our snapshot is out of date
// and would clobber newer state. On 409 we refresh from the server and (for user-initiated saves)
// reload so the view reflects reality. On success we record the new `_rev` so the next save isn't
// falsely rejected. Pass { silent: true } for automatic/render-time saves so they never alert/reload
// (which could loop) — they simply re-run on the next render. See SAVE_HARDENING_PLAN.md, Layer 1.
async function saveSeason(year, data, opts = {}) {
  const { silent = false } = opts;
  const seasons = getSeasons();
  // Adopt the freshest concurrency token before saving. An atomic submission/swap endpoint
  // (persistSubmission/removeSubmissionRemote → adoptRev) may have bumped _rev in localStorage
  // AFTER `data` was captured, while the caller's in-memory object still holds the older token —
  // so this save would falsely 409 as stale (the bug that left an approved submission's roster
  // unwritten: the submission flipped to 'approved' via the atomic call, then the roster's
  // full-season save was rejected and reloaded away). localStorage._rev only ever holds tokens
  // THIS client legitimately obtained (load / save-success / adoptRev), so staleness protection
  // against OTHER writers is preserved. See SAVE_HARDENING_PLAN.md, Layer 1.
  if (data && typeof data === 'object' && seasons[year] && seasons[year]._rev) {
    data._rev = seasons[year]._rev;
  }
  seasons[year] = data;
  setSeasonsLocal(seasons);
  try {
    const resp = await apiFetch('/api/seasons/' + year, { method: 'POST', body: JSON.stringify(data) });
    if (resp.status === 409) {
      // Stale snapshot (or a blocked destructive save). Pull the current server state down so the
      // local cache is correct again.
      try {
        const fresh = await fetch('/api/seasons');
        if (fresh.ok) {
          const srv = await fresh.json();
          if (srv && Object.keys(srv).length > 0) setSeasonsLocal(srv);
        }
      } catch (_) {
        /* offline — keep what we have */
      }
      if (!silent) {
        alert(
          'Your view was out of date, so that change was not saved — the latest data has been loaded. ' +
            'Please re-check and re-apply your change.'
        );
        // One-shot reload guard so a mis-classified caller can never loop. Cleared by loadData().
        if (!sessionStorage.getItem('wmmc_stale_reload')) {
          sessionStorage.setItem('wmmc_stale_reload', '1');
          location.reload();
        }
      }
      return false;
    }
    if (!resp.ok) {
      if (!silent) alert(`Save failed (${resp.status}). Please try again.`);
      return false;
    }
    // Success — capture the new concurrency token for subsequent saves.
    const body = await resp.json().catch(() => ({}));
    if (body && body._rev) {
      if (data && typeof data === 'object') data._rev = body._rev;
      const s = getSeasons();
      if (s[year]) {
        s[year]._rev = body._rev;
        setSeasonsLocal(s);
      }
    }
    return true;
  } catch (e) {
    if (!silent) console.warn('saveSeason error:', e.message);
    return false;
  }
}

// Persist just the schedule slice (schedule_dates + the ASG date / period deadlines computed with it)
// via the granular PUT /api/seasons/:year/schedule endpoint instead of a whole-season POST, so a
// schedule save can't clobber unrelated season fields. Callers update local state themselves (as
// before); this only swaps the transport and adopts the new concurrency token returned by the server.
// First slice of the granular-endpoints migration (#275).
async function saveSchedule(year, fields, opts = {}) {
  const { silent = false } = opts;
  try {
    const resp = await apiFetch('/api/seasons/' + year + '/schedule', { method: 'PUT', body: JSON.stringify(fields) });
    if (!resp.ok) {
      if (!silent) alert(`Schedule save failed (${resp.status}). Please try again.`);
      return false;
    }
    // schedule_dates is a hashed field — adopt the returned token so a later full-season save from
    // this client doesn't falsely 409 as stale.
    const body = await resp.json().catch(() => ({}));
    if (body && body._rev) {
      const s = getSeasons();
      if (s[year]) {
        s[year]._rev = body._rev;
        setSeasonsLocal(s);
      }
    }
    return true;
  } catch (e) {
    if (!silent) console.warn('saveSchedule error:', e.message);
    return false;
  }
}

// Atomically write one player pool (batters or pitchers) + its team map from a CSV upload via the
// dedicated PUT /api/seasons/:year/pool endpoint instead of a whole-season POST. The caller has
// already merged the CSV into the local pool (mergePlayerPool); this only swaps the transport and
// adopts the new concurrency token. Last slice of the granular-endpoints migration (#275).
async function savePool(year, type, pool, teamMap, opts = {}) {
  const { silent = false } = opts;
  try {
    const resp = await apiFetch('/api/seasons/' + year + '/pool', {
      method: 'PUT',
      body: JSON.stringify({ type, pool, team_map: teamMap }),
    });
    if (!resp.ok) {
      if (!silent) alert(`Pool save failed (${resp.status}). Please reload and try again.`);
      return false;
    }
    const body = await resp.json().catch(() => ({}));
    if (body && body._rev) {
      const s = getSeasons();
      if (s[year]) {
        s[year]._rev = body._rev;
        setSeasonsLocal(s);
      }
    }
    return true;
  } catch (e) {
    if (!silent) console.warn('savePool error:', e.message);
    return false;
  }
}

// Atomically mutate a single swap (deny / edit) via the dedicated swap endpoints instead of a
// whole-season POST, so a commissioner action can't be lost to a stale-save 409 — the "I approved/
// denied a swap but it didn't stick and the request came back" bug — and can't clobber unrelated
// season data. Mirrors the confirmed server swap + new _rev into localStorage. Returns the server
// payload on success, or null on failure (caller surfaces the error). Part of #275.
async function persistSwapMutation(year, swapId, method, path, body, onError) {
  try {
    const resp = await apiFetch(`/api/seasons/${year}/swaps/${swapId}${path}`, {
      method,
      body: JSON.stringify(body || {}),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      // A date edit on an approved swap is vetted by the server's destructive-save guard; offer
      // the commissioner an explicit override for a legitimate large correction (mirrors the
      // approve flow's force confirm). Managers have no force — the server rejects it — so they
      // get the plain error and are pointed at the commissioner instead.
      if (
        resp.status === 409 &&
        err.error === 'destructive_swap_edit_blocked' &&
        !(body && body.force) &&
        isLoggedInCommissioner()
      ) {
        const reasons = (err.reasons || []).join('\n• ');
        if (confirm(`This edit looks destructive:\n\n• ${reasons}\n\nApply anyway?`)) {
          return persistSwapMutation(year, swapId, method, path, { ...(body || {}), force: true });
        }
        return null;
      }
      // The server sends a plain-English `detail` for the rejections a manager can actually hit
      // (not yours, already in effect, players not editable, date out of range) — show that rather
      // than the machine code, inline when the caller has somewhere to put it.
      const msg = err.detail || err.error || `Swap update failed (${resp.status}). Please reload and try again.`;
      if (onError) onError(msg);
      else alert(msg);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    const seasons = getSeasons();
    const sd = seasons[year];
    if (sd && Array.isArray(sd.swaps) && data.swap) {
      const i = sd.swaps.findIndex((s) => String(s.id) === String(swapId));
      if (i >= 0) sd.swaps[i] = data.swap;
      if (data._rev) sd._rev = data._rev;
      setSeasonsLocal(seasons);
    }
    return data;
  } catch (e) {
    alert(`Swap update failed — ${e.message}. Please reload and try again.`);
    return null;
  }
}

// ---- Atomic submission persistence ----
// Roster submissions are written through dedicated endpoints, never the clobber-prone
// full-season save (saveSeason no longer persists submissions — the server treats them as
// authoritative). Each call awaits a confirmed server response and mirrors it into
// localStorage so the local view matches the server. Returns the saved record (or true for
// delete) on success, or null/false on failure — callers surface the error to the user.
// Adopt the fresh concurrency token returned by an atomic endpoint (swap/submission). Those
// endpoints change hashed fields, so without adopting the new token a following full-season save
// (e.g. approving a swap) would falsely 409 as stale. See SAVE_HARDENING_PLAN.md, Layer 1.
function adoptRev(rev) {
  if (!rev) return;
  const seasons = getSeasons();
  if (seasons[SELECTED_SEASON]) {
    seasons[SELECTED_SEASON]._rev = rev;
    setSeasonsLocal(seasons);
  }
}

function mirrorSubmissionLocally(period, manager, submission) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;
  if (period === 'pp1') {
    if (!sd.initial_submissions) sd.initial_submissions = {};
    if (submission) sd.initial_submissions[manager] = submission;
    else delete sd.initial_submissions[manager];
  } else {
    if (!sd.period_submissions) sd.period_submissions = {};
    if (!sd.period_submissions[period]) sd.period_submissions[period] = {};
    if (submission) sd.period_submissions[period][manager] = submission;
    else delete sd.period_submissions[period][manager];
  }
  setSeasonsLocal(seasons);
}

// ---- Late-submission window (server-authoritative) ----
//
// Whether a period's roster deadline has passed — and, if it has, which day a roster submitted
// now would start on — is decided by the SERVER (GET /submission-window/:period). It has to be:
// the answer depends on today's real first pitch, which only the server can look up, and on a
// clock a manager cannot set. app.js's own getPeriodDeadline stays for instant rendering and for
// the plain open/closed question; this cache is what the late-mode UI actually offers buttons on.
//
// Keyed by period. A period with nothing cached renders its normal (non-late) form, so a failed
// or in-flight fetch degrades to today's behavior rather than to a wrong effective date.
const SUBMISSION_WINDOWS = {};
const SUBMISSION_WINDOWS_AT = {};
const SUBMISSION_WINDOWS_INFLIGHT = {};
// How long a cached answer is trusted. The only thing that moves inside a period is "has today's
// first pitch happened", so a minute is plenty — and it keeps a roster page that re-renders on
// every click from re-asking the MLB schedule each time.
const SUBMISSION_WINDOW_TTL_MS = 60 * 1000;

// Record a window the server handed back alongside a write, so the next render reads the same
// answer the stamp was made from instead of a stale one.
function cacheSubmissionWindow(period, win) {
  if (!win) return;
  SUBMISSION_WINDOWS[period] = win;
  SUBMISSION_WINDOWS_AT[period] = Date.now();
}

// Fetch a period's window, honoring the TTL cache. Deduplicated per period, because several
// callers ask for the same one in the same tick.
async function loadSubmissionWindow(period, { force = false } = {}) {
  const fresh = SUBMISSION_WINDOWS_AT[period] && Date.now() - SUBMISSION_WINDOWS_AT[period] < SUBMISSION_WINDOW_TTL_MS;
  if (!force && fresh) return SUBMISSION_WINDOWS[period];
  if (SUBMISSION_WINDOWS_INFLIGHT[period]) return SUBMISSION_WINDOWS_INFLIGHT[period];
  const req = (async () => {
    try {
      const resp = await fetch(`/api/seasons/${SELECTED_SEASON}/submission-window/${period}`);
      if (!resp.ok) return null;
      const win = await resp.json();
      cacheSubmissionWindow(period, win);
      return win;
    } catch (_) {
      return null;
    } finally {
      delete SUBMISSION_WINDOWS_INFLIGHT[period];
    }
  })();
  SUBMISSION_WINDOWS_INFLIGHT[period] = req;
  return req;
}

// Ask the server about every period whose card is on screen, then re-render ONCE if any answer
// moved. Called after the roster page paints, so the first paint never waits on the network and a
// season whose server predates this endpoint simply keeps rendering the way it always did.
async function refreshSubmissionWindows(periods, rerender) {
  const snapshot = () => periods.map((p) => JSON.stringify(SUBMISSION_WINDOWS[p] || null)).join('|');
  const before = snapshot();
  await Promise.all(periods.map((p) => loadSubmissionWindow(p)));
  if (snapshot() !== before && typeof rerender === 'function') rerender();
}

// Is this period past its lock, per the server? Unknown (nothing cached) reads as NOT late — see
// the cache comment above.
function periodIsLate(period) {
  const win = SUBMISSION_WINDOWS[period];
  return !!(win && win.is_late);
}

// The date a roster submitted right now would take effect, per the server. Null when the period
// has no viable day left (or we haven't asked yet).
function periodEffectiveDate(period) {
  const win = SUBMISSION_WINDOWS[period];
  return (win && win.effective_date) || null;
}

// Is this period still running — i.e. is there any of it left to play? Late mode only makes sense
// while there is: once a period has ENDED, a manager who never submitted for it has nothing left
// to gain, and leaving the form up would put a permanent "you missed Pool Play 1" card on the
// roster page for the rest of the season. A late submission or plea already on file keeps the
// card alive past that, so a request in flight can still be seen through.
function periodStillRunning(period, sub) {
  const win = SUBMISSION_WINDOWS[period];
  if (!win) return false;
  if (submissionLateState(sub).late) return true;
  return !win.period_end || (!!win.today_et && win.today_et <= win.period_end);
}

// 'YYYY-MM-DD' rendered as a human date, pinned to noon UTC so the printed calendar day can't
// shift with the reader's timezone.
function fmtEffectiveDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

async function persistSubmission(period, manager, sub, { quiet = false, forgivenessReason = null } = {}) {
  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/submissions`, {
      method: 'POST',
      body: JSON.stringify({
        period,
        manager,
        batters: sub.batters || [],
        pitchers: sub.pitchers || [],
        status: sub.status || 'draft',
        // Present only on a "Beg Commish for Forgiveness" submission. Its presence is what turns
        // the submission into a plea; the effective date it earns is the commissioner's to set.
        ...(forgivenessReason ? { forgiveness_reason: forgivenessReason } : {}),
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }
    const { submission, window: subWindow, _rev } = await resp.json();
    mirrorSubmissionLocally(period, manager, submission);
    // The POST resolved the window server-side anyway; keep it so the card re-renders against
    // the same answer the stamp was made from instead of a stale one.
    cacheSubmissionWindow(period, subWindow);
    adoptRev(_rev);
    return submission;
  } catch (e) {
    if (!quiet) {
      alert(`Your submission did not save — ${e.message}. Please check your connection and try again.`);
    }
    return null;
  }
}

async function removeSubmissionRemote(period, manager) {
  try {
    const resp = await apiFetch(
      `/api/seasons/${SELECTED_SEASON}/submissions/${period}/${encodeURIComponent(manager)}`,
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }
    const { _rev } = await resp.json().catch(() => ({}));
    mirrorSubmissionLocally(period, manager, null);
    adoptRev(_rev);
    return true;
  } catch (e) {
    alert(`Delete failed — ${e.message}. Please try again.`);
    return false;
  }
}

function readManagersJSON() {
  if (MANAGERS_JSON == null) {
    try {
      MANAGERS_JSON = localStorage.getItem('wmmc_managers') || '[]';
    } catch (_) {
      MANAGERS_JSON = '[]';
    }
  }
  return MANAGERS_JSON;
}

function setManagersLocal(managersOrJson) {
  const json = typeof managersOrJson === 'string' ? managersOrJson : JSON.stringify(managersOrJson);
  MANAGERS_JSON = json;
  try {
    localStorage.setItem('wmmc_managers', json);
  } catch (_) {
    try {
      localStorage.removeItem('wmmc_managers');
      localStorage.setItem('wmmc_managers', json);
    } catch (e) {
      console.warn('wmmc_managers localStorage mirror failed (quota?) — using in-memory data:', e.message);
    }
  }
}

function getManagers() {
  return JSON.parse(readManagersJSON());
}
function saveManagers(managers) {
  setManagersLocal(managers);
  // Persist to server in background
  apiFetch('/api/managers', {
    method: 'POST',
    body: JSON.stringify(managers),
  }).catch(() => {});
}

// ============================================================
// Initialization
// ============================================================
async function loadData() {
  // ---- Instant boot from cache (no network) ----
  // The managers list and the logged-in email are mirrored in localStorage, so we can restore
  // the session and render from the cached seasons synchronously — before any network round-trip.
  // This stops a returning user from seeing the login screen flash (the app appearing to "log out
  // and back in") while the background sync below runs. The sync then refreshes the data underneath
  // and re-renders only if it actually changed.
  restoreSessionFromCache();

  // ---- Sync from server (shared database) ----
  let changed = false;
  try {
    const [seasonsResp, managersResp] = await Promise.all([fetch('/api/seasons'), fetch('/api/managers')]);
    if (seasonsResp.ok) {
      const serverSeasons = await seasonsResp.json();
      if (serverSeasons && Object.keys(serverSeasons).length > 0) {
        if (readSeasonsJSON() !== JSON.stringify(serverSeasons)) {
          setSeasonsLocal(serverSeasons);
          changed = true;
        }
        // Fresh data loaded — release the one-shot stale-save reload guard.
        try {
          sessionStorage.removeItem('wmmc_stale_reload');
        } catch (_) {
          /* sessionStorage unavailable — ignore */
        }
      }
    }
    if (managersResp.ok) {
      const serverManagers = await managersResp.json();
      if (serverManagers && serverManagers.length > 0) {
        if (readManagersJSON() !== JSON.stringify(serverManagers)) {
          setManagersLocal(serverManagers);
          changed = true;
        }
      }
    }
  } catch (e) {
    // Server unavailable — fall back to localStorage
    console.warn('Server sync unavailable, using local data:', e.message);
  }

  // Ensure we always have 2025 as a historical season
  const seasons = getSeasons();
  if (!seasons['2025']) {
    try {
      const resp = await fetch('data.json');
      const legacy = await resp.json();
      seasons['2025'] = { status: 'completed', data: legacy };
      setSeasonsLocal(seasons);
      // Push to server
      apiFetch('/api/seasons/2025', {
        method: 'POST',
        body: JSON.stringify(seasons['2025']),
      }).catch(() => {});
    } catch (e) {
      // data.json might not exist
    }
  }

  // Seed managers from 2025 email_map if managers list is empty
  if (getManagers().length === 0 && seasons['2025'] && seasons['2025'].data && seasons['2025'].data.email_map) {
    const emailMap = seasons['2025'].data.email_map;
    const mgrs = Object.entries(emailMap).map(([email, name]) => ({
      name,
      email,
      commissioner: email === 'daniel.kortan@gmail.com',
    }));
    saveManagers(mgrs);
  }

  // Ensure current year season exists
  if (!seasons[CURRENT_YEAR]) {
    seasons[CURRENT_YEAR] = {
      status: 'active',
      batters_pool: [],
      pitchers_pool: [],
      weekly_batting: [],
      weekly_pitching: [],
      rosters: {},
      team_weekly: [],
    };
    setSeasonsLocal(seasons);
    // Push to server
    apiFetch('/api/seasons/' + CURRENT_YEAR, {
      method: 'POST',
      body: JSON.stringify(seasons[CURRENT_YEAR]),
    }).catch(() => {});
  }

  // Load banner background config from server
  await loadBannerConfig();

  // Always show footer year and version (independent of auth)
  document.getElementById('footer-year').textContent = CURRENT_YEAR;
  fetch('/version.json')
    .then((r) => r.json())
    .then((d) => {
      document.getElementById('footer-version').textContent = 'v' + d.version;
    })
    .catch(() => {});

  // Finalize the login state now that the server sync has completed. If the session was already
  // restored from cache above, this only re-renders when the fresh data actually changed. If it
  // could NOT be restored earlier (e.g. first load on a new device, where the managers list wasn't
  // cached yet), the sync may now have what we need, so try once more before falling back to login.
  const wasActiveBeforeSync = !!LOGGED_IN_EMAIL;
  if (restoreSessionFromCache()) {
    // If the session was already active from the cache-phase restore, the first paint used cached
    // data — rebuild the season selector (a brand-new season may not have been cached) and re-render
    // only when the fresh sync actually changed something. If the session was restored just now
    // (managers arrived with the sync), enterApp already rendered the fresh data.
    if (wasActiveBeforeSync && changed) {
      buildSeasonSelector();
      init();
    }
  } else {
    // No valid session. Clear any stale saved auth (an email that no longer maps to a manager even
    // after the fresh sync) and reveal the login screen.
    const savedAuth = localStorage.getItem('wmmc_logged_in_email');
    if (savedAuth && !findManagerByEmail(savedAuth)) {
      localStorage.removeItem('wmmc_logged_in_email');
    }
    document.getElementById('login-screen').style.display = 'flex';
  }

  setupLoginHandlers();
  initGoogleSignIn();
  startVersionWatcher();
}

// ============================================================
// Live server sync — fetches fresh seasons + managers, updates
// localStorage, returns true if anything changed.
// ============================================================
async function syncFromServer() {
  try {
    const [seasonsResp, managersResp] = await Promise.all([fetch('/api/seasons'), fetch('/api/managers')]);
    let changed = false;
    if (seasonsResp.ok) {
      const serverSeasons = await seasonsResp.json();
      if (serverSeasons && Object.keys(serverSeasons).length > 0) {
        const incoming = JSON.stringify(serverSeasons);
        if (readSeasonsJSON() !== incoming) {
          setSeasonsLocal(incoming);
          changed = true;
        }
      }
    }
    if (managersResp.ok) {
      const serverManagers = await managersResp.json();
      if (serverManagers && serverManagers.length > 0) {
        const incoming = JSON.stringify(serverManagers);
        if (readManagersJSON() !== incoming) {
          setManagersLocal(incoming);
          changed = true;
        }
      }
    }
    return changed;
  } catch (e) {
    return false;
  }
}

// True while the user is actively engaged with a form control — focused on an
// input/select/textarea or inside an open custom dropdown / inline swap-edit form / player
// search. Used to hold off background poll re-renders, which replace the DOM under the user
// and wipe typed text, dropdown state, and scroll position.
function isUserMidInteraction() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.matches && el.matches('input, textarea, select, [contenteditable="true"]')) return true;
  return !!(el.closest && el.closest('.custom-dd, .swap-edit-form, .player-search-container'));
}

// ============================================================
// Authentication
// ============================================================
function findManagerByEmail(email) {
  const managers = getManagers();
  return managers.find((m) => m.email && m.email.toLowerCase() === email.toLowerCase());
}

// Restore the logged-in session from the cached managers list (no network) and render from the
// cached seasons via enterApp. Returns true if a session is active — restored just now, or already
// restored on an earlier call. Idempotent: enterApp (which renders and starts the polls) runs only
// on the first successful restore. When the saved email isn't found in the — possibly not-yet-synced
// — managers list, returns false WITHOUT clearing the saved auth, so loadData can retry after the
// server sync before deciding the session is genuinely invalid.
function restoreSessionFromCache() {
  if (LOGGED_IN_EMAIL) return true;
  let savedAuth;
  try {
    savedAuth = localStorage.getItem('wmmc_logged_in_email');
  } catch (_) {
    return false;
  }
  if (!savedAuth) return false;
  const mgr = findManagerByEmail(savedAuth);
  if (!mgr) return false;
  LOGGED_IN_EMAIL = savedAuth.toLowerCase();
  enterApp(mgr);
  return true;
}

function enterApp(mgr) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('user-bar').style.display = 'flex';
  document.getElementById('user-display-name').textContent = mgr.name;
  setupUserBar();

  // Apply the user's saved theme. The account preference wins; if the account has
  // none yet, fall back to whatever was cached locally (defaults to light).
  applyTheme(mgr.theme === 'dark' || mgr.theme === 'light' ? mgr.theme : getStoredTheme());

  // Auto-auth commissioner if applicable
  if (mgr.commissioner) {
    COMMISSIONER_EMAIL = LOGGED_IN_EMAIL;
    startPendingSwapPoll();
  }

  // Show/hide commissioner nav based on role
  const commBtn = document.getElementById('commissioner-nav-btn');
  if (commBtn) {
    commBtn.style.display = mgr.commissioner ? '' : 'none';
  }

  buildSeasonSelector();
  setupNav();
  updateOnlineStatus();
  loadHypoScenario();

  // Restore the tab the user was on before refreshing. The standalone Trends
  // tab merged into Season Stats (the old Weekly Scores tab) — map the legacy
  // saved value so returning users land on the merged tab, not the default.
  let savedTab = localStorage.getItem('wmmc_active_tab');
  if (savedTab === 'trends') savedTab = 'weekly';
  // A #hash deep link naming a tab (e.g. wmmc.live/#swap-log from a Slack swap notification)
  // wins over the saved tab, so a link can land directly on that tab after login.
  // A shared What If link carries its scenario in the hash (#whatif=<encoded>), so the tab name
  // is the part before the '='. No existing tab id contains one, so this is a no-op for the rest.
  const hashTab = (window.location.hash || '').replace(/^#/, '').split('=')[0];
  if (hashTab && document.querySelector(`.nav-btn[data-tab="${hashTab}"]`)) savedTab = hashTab;
  if (savedTab) {
    const targetBtn = document.querySelector(`.nav-btn[data-tab="${savedTab}"]`);
    const targetSection = document.getElementById(savedTab);
    if (targetBtn && targetSection) {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      targetBtn.classList.add('active');
      targetSection.classList.add('active');
    }
  }

  init();
  // Trigger tab-specific renders for tabs that need them
  if (savedTab === 'weekly') renderTrends();
  if (savedTab === 'swap-log') renderSwapLog('swap-log-public', false);
  if (savedTab === 'hall-of-fame') renderHallOfFame();
  if (savedTab === 'whatif') renderWhatIf();
  if (savedTab === 'live') startLivePolling();

  // Poll for changes every 45 seconds so logged-in users always see
  // the latest data without needing a page refresh. Skip the re-render while the user is
  // mid-interaction with a form control (typing a player search, editing a date/stat field,
  // choosing from a dropdown) — a background re-render replaces the DOM under them and wipes
  // that in-progress state. The fresh data is already cached locally, so the next idle poll
  // tick (or any user action) renders it.
  setInterval(async () => {
    if (!LOGGED_IN_EMAIL) return;
    const changed = await syncFromServer();
    if (changed && !isUserMidInteraction()) init();
  }, 45000);
}

async function handleLogin(email, password) {
  email = email.trim().toLowerCase();
  const errEl = document.getElementById('login-error-msg');

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    return;
  }

  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      errEl.textContent = data.error || 'Incorrect email or password.';
      return;
    }

    errEl.textContent = '';
    LOGGED_IN_EMAIL = email;
    localStorage.setItem('wmmc_logged_in_email', email);
    // Cache password so apiFetch can send it on subsequent mutating calls.
    // The server re-verifies on every request — no session store.
    localStorage.setItem('wmmc_logged_in_password', password);
    // Use locally cached manager (already synced from server during loadData)
    const mgr = findManagerByEmail(email) || data.manager;
    enterApp(mgr);
  } catch (e) {
    errEl.textContent = 'Login failed. Please check your connection and try again.';
  }
}

async function handleGoogleCredential(response) {
  const errEl = document.getElementById('google-signin-error');
  errEl.textContent = '';
  try {
    // Send the raw credential to the server, which verifies Google's signature,
    // maps the verified email to a manager, and returns a reusable auth token.
    const resp = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      errEl.textContent = data.error || 'Google sign-in failed. Please try email login.';
      return;
    }

    const email = data.manager.email.toLowerCase();
    LOGGED_IN_EMAIL = email;
    localStorage.setItem('wmmc_logged_in_email', email);
    // Store the server-issued token where apiFetch expects the password — the
    // server re-verifies it (as a token) on every request, no session store.
    localStorage.setItem('wmmc_logged_in_password', data.token);
    // Prefer the locally cached manager (synced from server), fall back to the response.
    const mgr = findManagerByEmail(email) || data.manager;
    enterApp(mgr);
  } catch (e) {
    errEl.textContent = 'Google sign-in failed. Please try email login.';
  }
}

function updatePendingSwapBadge(count) {
  const badge = document.getElementById('comm-pending-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function startPendingSwapPoll() {
  if (pendingSwapPollTimer) clearInterval(pendingSwapPollTimer);
  const poll = () => {
    if (!SELECTED_SEASON) return;
    fetch(`/api/pending-count?year=${encodeURIComponent(SELECTED_SEASON)}`)
      .then((r) => r.json())
      .then((data) => updatePendingSwapBadge(data.count || 0))
      .catch(() => {});
  };
  poll();
  pendingSwapPollTimer = setInterval(poll, 60000);
}

function stopPendingSwapPoll() {
  if (pendingSwapPollTimer) clearInterval(pendingSwapPollTimer);
  pendingSwapPollTimer = null;
  updatePendingSwapBadge(0);
}

function handleLogout() {
  stopPendingSwapPoll();
  LOGGED_IN_EMAIL = null;
  COMMISSIONER_EMAIL = null;
  LOGGED_IN_EMAIL = null;
  localStorage.removeItem('wmmc_logged_in_email');
  localStorage.removeItem('wmmc_logged_in_password');
  window.location.reload();
}

function setupLoginHandlers() {
  document.getElementById('login-submit-btn').onclick = () => {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    handleLogin(email, password);
  };

  document.getElementById('login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-submit-btn').click();
  });
  document.getElementById('login-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-password').focus();
  });

  document.getElementById('logout-btn').onclick = handleLogout;
}

function setupUserBar() {
  const dropdown = document.getElementById('user-dropdown');
  const trigger = document.getElementById('user-dropdown-trigger');

  trigger.onclick = (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  };

  document.addEventListener('click', () => {
    dropdown.classList.remove('open');
  });

  document.getElementById('change-password-btn').onclick = () => {
    dropdown.classList.remove('open');
    openChangePasswordModal();
  };

  const themeBtn = document.getElementById('theme-toggle-btn');
  if (themeBtn) {
    themeBtn.textContent = getStoredTheme() === 'dark' ? 'Light Mode' : 'Dark Mode';
    themeBtn.onclick = () => {
      const next = getStoredTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      persistTheme(next);
      dropdown.classList.remove('open');
    };
  }
}

function openChangePasswordModal() {
  const existing = document.getElementById('pw-change-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pw-change-modal';
  overlay.className = 'pw-modal-overlay';
  overlay.innerHTML = `
    <div class="pw-modal-card" role="dialog" aria-modal="true" aria-label="Change Password">
      <h3>Change Password</h3>
      <div class="pw-modal-fields">
        <input type="password" id="pw-current" placeholder="Current password" autocomplete="current-password">
        <input type="password" id="pw-new" placeholder="New password (min. 3 characters)" autocomplete="new-password">
        <input type="password" id="pw-confirm" placeholder="Confirm new password" autocomplete="new-password">
      </div>
      <p class="pw-modal-error" id="pw-modal-error"></p>
      <div class="pw-modal-actions">
        <button class="btn btn-secondary" id="pw-modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="pw-modal-save">Save Password</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#pw-modal-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const saveBtn = overlay.querySelector('#pw-modal-save');
  const doSave = async () => {
    const currentPassword = overlay.querySelector('#pw-current').value;
    const newPassword = overlay.querySelector('#pw-new').value;
    const confirmPassword = overlay.querySelector('#pw-confirm').value;
    const errEl = overlay.querySelector('#pw-modal-error');
    errEl.textContent = '';

    if (!currentPassword) {
      errEl.textContent = 'Please enter your current password.';
      return;
    }
    if (newPassword.length < 3) {
      errEl.textContent = 'New password must be at least 3 characters.';
      return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = 'New passwords do not match.';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      // change-password verifies currentPassword itself, so it doesn't go
      // through apiFetch / requireCommissioner — it's open to any logged-in user.
      const resp = await fetch(`/api/managers/${encodeURIComponent(LOGGED_IN_EMAIL)}/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Email': LOGGED_IN_EMAIL },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.error || 'Failed to change password.';
        return;
      }
      // Refresh cached password so future apiFetch calls succeed.
      localStorage.setItem('wmmc_logged_in_password', newPassword);
      overlay.remove();
      // Show brief confirmation
      const toast = document.createElement('div');
      toast.style.cssText =
        'position:fixed;bottom:1.5rem;right:1.5rem;background:#16a34a;color:#fff;padding:0.65rem 1.1rem;border-radius:8px;font-size:0.875rem;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
      toast.textContent = 'Password updated successfully.';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    } catch (e) {
      errEl.textContent = 'Something went wrong. Please try again.';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Password';
    }
  };

  saveBtn.onclick = doSave;
  overlay.querySelector('#pw-confirm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSave();
  });
  setTimeout(() => overlay.querySelector('#pw-current').focus(), 50);
}

function hideGoogleSignIn() {
  const container = document.getElementById('google-signin-container');
  const divider = container ? container.previousElementSibling : null;
  if (container) container.style.display = 'none';
  if (divider && divider.classList.contains('login-divider')) divider.style.display = 'none';
}

async function initGoogleSignIn() {
  // Resolve the client ID from the server once (it lives in the GOOGLE_CLIENT_ID
  // env var). If unset, Google sign-in stays hidden and email/password is used.
  if (!GOOGLE_CLIENT_ID) {
    try {
      const resp = await fetch('/api/auth/config');
      const cfg = await resp.json();
      GOOGLE_CLIENT_ID = cfg.googleClientId || '';
    } catch (e) {
      GOOGLE_CLIENT_ID = '';
    }
  }
  if (!GOOGLE_CLIENT_ID) {
    hideGoogleSignIn();
    return;
  }

  // The GIS library loads async; retry until it's ready.
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initGoogleSignIn, 500);
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
  });

  // GSI requires a numeric pixel width (200-400); it rejects '100%'. Match the
  // container's width so the button still fills it, clamped to GSI's valid range.
  const container = document.getElementById('google-signin-container');
  const containerWidth = container.clientWidth || 400;
  google.accounts.id.renderButton(container, {
    theme: 'outline',
    size: 'large',
    width: Math.min(400, Math.max(200, Math.round(containerWidth))),
    text: 'signin_with',
  });
}

// ---- Online Users Tracking ----
// getInitials lives in js/utils.js (loaded via window globals by js/index.js).

function updateOnlineStatus() {
  if (!LOGGED_IN_EMAIL) return;
  const mgr = findManagerByEmail(LOGGED_IN_EMAIL);
  if (!mgr) return;
  try {
    const onlineData = JSON.parse(localStorage.getItem('wmmc_online_users') || '{}');
    onlineData[LOGGED_IN_EMAIL] = { name: mgr.name, timestamp: Date.now() };
    localStorage.setItem('wmmc_online_users', JSON.stringify(onlineData));
    // Also try server-side heartbeat
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LOGGED_IN_EMAIL, name: mgr.name }),
    }).catch(() => {});
  } catch {
    /* heartbeat fire-and-forget; ignore failures */
  }
  renderOnlineUsers();
}

function renderOnlineUsers() {
  const bar = document.getElementById('online-users-bar');
  if (!bar) return;
  let onlineData = {};
  try {
    onlineData = JSON.parse(localStorage.getItem('wmmc_online_users') || '{}');
  } catch {
    /* corrupt cache — fall back to empty */
  }

  // Also try to get from server
  fetch('/api/online-users')
    .then((r) => r.json())
    .then((serverData) => {
      if (serverData && typeof serverData === 'object') {
        Object.assign(onlineData, serverData);
        localStorage.setItem('wmmc_online_users', JSON.stringify(onlineData));
      }
      displayOnlineUsers(bar, onlineData);
    })
    .catch(() => {
      displayOnlineUsers(bar, onlineData);
    });
}

function displayOnlineUsers(bar, onlineData) {
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const active = Object.values(onlineData).filter((data) => now - data.timestamp < FIVE_MIN);

  if (active.length === 0) {
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = active
    .map((u) => {
      const initials = getInitials(u.name);
      const isMe = u.name === (findManagerByEmail(LOGGED_IN_EMAIL) || {}).name;
      return `<span class="online-user-chip${isMe ? ' online-user-me' : ''}" title="${u.name}">${initials}</span>`;
    })
    .join('');
}

// Heartbeat every 60 seconds
setInterval(updateOnlineStatus, 60000);

function buildSeasonSelector() {
  const seasons = getSeasons();
  const select = document.getElementById('season-select');
  select.innerHTML = '';

  const years = Object.keys(seasons).sort((a, b) => b - a);
  years.forEach((year) => {
    const opt = document.createElement('option');
    opt.value = year;
    const status = seasons[year].status === 'active' ? ' (Active)' : ' (Completed)';
    opt.textContent = year + status;
    select.appendChild(opt);
  });

  select.value = String(CURRENT_YEAR);
  SELECTED_SEASON = String(CURRENT_YEAR);

  // Attach the change listener once — buildSeasonSelector may run again after the background sync
  // (to pick up a season that wasn't in the cache at first paint), and re-adding it would fire the
  // handler twice per change.
  if (!_seasonSelectorListenerAttached) {
    _seasonSelectorListenerAttached = true;
    select.addEventListener('change', async () => {
      SELECTED_SEASON = select.value;
      await syncFromServer();
      init();
    });
  }
}
let _seasonSelectorListenerAttached = false;

// ============================================================
// Version watcher — prompt a reload when a new build is deployed
// ============================================================
// GET /api/build returns ASSET_VERSION, which changes on every deploy/restart. We capture it
// once on load, then poll; when it changes, this tab is running stale code, so we surface a
// non-blocking "Reload" prompt. Gentle alternative to forcing logout on every deploy.
let _versionWatcherStarted = false;
let _loadedBuild = null;

async function fetchBuild() {
  try {
    const r = await fetch('/api/build', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.build != null ? d.build : null;
  } catch (e) {
    return null;
  }
}

function showVersionUpdateBanner() {
  if (document.getElementById('version-update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'version-update-banner';
  bar.setAttribute('role', 'alert');
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#1e3a5f;color:#fff;' +
    'padding:0.75rem 1rem;display:flex;align-items:center;justify-content:center;gap:0.75rem;' +
    'font-size:0.9rem;box-shadow:0 -2px 10px rgba(0,0,0,0.25);';
  const msg = document.createElement('span');
  msg.textContent = 'A new version of WMMC is available.';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText =
    'background:#fff;color:#1e3a5f;border:none;border-radius:6px;padding:0.35rem 0.9rem;font-weight:600;cursor:pointer;';
  btn.onclick = () => window.location.reload();
  bar.appendChild(msg);
  bar.appendChild(btn);
  document.body.appendChild(bar);
}

async function checkBuild() {
  if (_loadedBuild == null) return;
  const current = await fetchBuild();
  if (current != null && current !== _loadedBuild) showVersionUpdateBanner();
}

async function startVersionWatcher() {
  if (_versionWatcherStarted) return;
  _versionWatcherStarted = true;
  _loadedBuild = await fetchBuild();
  if (_loadedBuild == null) return; // endpoint unavailable (older server) — watcher stays inert
  setInterval(checkBuild, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkBuild();
  });
}

function init() {
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];

  if (!seasonData) return;

  try {
    if (seasonData.status === 'completed' && seasonData.data) {
      DATA = seasonData.data;
      showHistoricalSeason();
    } else {
      DATA = null;
      showActiveSeason(seasonData);
    }
    // After the branch, so it runs for both and clears itself on a season that isn't closed —
    // switching from a closed season to a live one must not leave last year's champion card
    // sitting above this year's scoreboard.
    renderSeasonChampionAnnouncement(seasonData);
  } catch (e) {
    console.error('Error rendering season:', e);
  }

  setupMyRoster();
  renderLeagueInfo();
  renderCommissioner();
  updateSubmissionWarningBanner();
}

// ============================================================
// Navigation
// ============================================================
let _navInitialized = false;
function setupNav() {
  if (_navInitialized) return;
  _navInitialized = true;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const section = document.getElementById(btn.dataset.tab);
      if (section) section.classList.add('active');
      localStorage.setItem('wmmc_active_tab', btn.dataset.tab);
      // Always pull fresh data from server before rendering the new tab
      await syncFromServer();
      init();
      // Trends charts live inside the Season Stats tab and only render on
      // activation — Chart.js canvases size to zero inside a hidden section.
      if (btn.dataset.tab === 'weekly') renderTrends();
      if (btn.dataset.tab === 'swap-log') renderSwapLog('swap-log-public', false);
      if (btn.dataset.tab === 'hall-of-fame') renderHallOfFame();
      if (btn.dataset.tab === 'whatif') renderWhatIf();
      // Live tab owns its own polling lifecycle — start when entering, stop on leaving.
      if (btn.dataset.tab === 'live') startLivePolling();
      else stopLivePolling();
    });
  });

  // A shared What If link (#whatif=<scenario>) opened while the app is ALREADY loaded is a
  // same-document navigation — the page never reloads, so the boot-time hash handling in enterApp
  // never runs and the link would silently do nothing. Clicking one from Slack while the tab is
  // already open is the common case, so handle the hash change directly.
  window.addEventListener('hashchange', () => {
    const tab = (window.location.hash || '').replace(/^#/, '').split('=')[0];
    const btn = tab && document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (!btn) return;
    if (tab === 'whatif') loadHypoScenario();
    btn.click();
  });
}

// ============================================================
// Historical Season (completed)
// ============================================================
function showHistoricalSeason() {
  renderScoreboard();
  renderSeasonAccolades();
  renderWeekly();
  renderPlayers();
  renderBracket();
}

// ============================================================
// LIVE SCORING — auto-refreshing view of in-progress + final games
// for the active schedule week.
//
// Polling policy (to keep MLB API traffic light):
//   - One fetch immediately when the tab is opened.
//   - While at least one game is Live, re-poll every 2 minutes.
//   - After all live games end, keep polling every 2 minutes for a
//     30-minute grace window so final-stat corrections come through.
//   - Once the grace window elapses with no Live games, polling
//     stops. Switching tabs and coming back triggers a fresh fetch.
//   - Background tabs never fetch; on returning to a visible state
//     a fetch fires only if the cached data is older than the poll
//     interval and we're still inside the polling window.
// ============================================================
const LIVE_POLL_MS = 120_000; // 2 minutes between active polls
const LIVE_GRACE_MS = 30 * 60 * 1000; // 30 minutes after last live game
let _livePollTimer = null;
let _liveLastFetchedAt = 0;
let _liveLastSawLiveGame = 0;
let _liveViewDate = null; // null = today/live, 'YYYY-MM-DD' = historical date view
// The game day the live view is currently showing, as resolved by the server (see resolveLiveDay
// in server.js). This is NOT always the ET calendar date: a slate that started last night holds
// the view through the following morning, until 2h before the new day's first pitch or noon ET,
// whichever is earlier. Populated from every /api/mlb/live response; until the first one lands we
// fall back to the calendar date, which is correct for all but the hold-over window.
let _liveDayET = null;
// Epoch ms at which the live day flips to the new calendar date, or null when it already has.
let _liveRolloverAt = null;
const _calendarDayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const liveDayET = () => _liveDayET || _calendarDayET();
// Tracks which manager rows have their today's-stats drop-down expanded so the
// 2-minute poll re-render doesn't collapse the panel under the user.
const _liveExpandedManagers = new Set();
// Same idea for the per-game full-boxscore expand panels in Today's Games.
// Values are gamePks (as strings).
const _liveExpandedGames = new Set();
const _liveKey = (s) =>
  String(s || '')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase();

// During QF/SF/Finals the Live tab shows the round's head-to-head matchups (mirroring the
// Playoff Bracket card) instead of a ranked standings table. Shared by the live (today) and
// historical-date views: `matchups` comes from playoffRoundMatchups, `byName` maps manager →
// that view's endpoint row, `renderPanel(name)` builds the expandable player panel, and
// `subline(row)` the muted per-team stat line. Expansion state rides the same
// _liveExpandedManagers set / toggleLiveManagerDetails ids as the table view, so panels
// survive the 2-minute poll re-render.
function renderLiveMatchupCards(matchups, byName, renderPanel, subline) {
  const teamHtml = (t, leader) => {
    const r = byName[t.name];
    const key = _liveKey(t.name);
    const expanded = _liveExpandedManagers.has(t.name);
    const arrow = expanded ? '&#9650;' : '&#9660;';
    const nameCls = r && r.is_active_today ? 'live-mgr-active' : '';
    const total = r ? (r.round_total ?? 0).toFixed(2) : '&mdash;';
    const sub = subline(r);
    return `
      <div class="live-matchup-team ${leader ? 'live-matchup-leader' : ''}" onclick="toggleLiveManagerDetails('${key}','${jsStr(t.name)}')">
        <div class="live-matchup-main">
          <span class="bracket-seed">${t.seed || ''}</span>
          <span class="live-matchup-name ${nameCls}">${esc(t.name)}</span>
          <span class="sb-expand-arrow" id="live-arrow-${key}">${arrow}</span>
          <span class="live-matchup-total">${total}</span>
        </div>
        ${sub ? `<div class="live-matchup-sub">${sub}</div>` : ''}
      </div>
      <div class="live-matchup-detail" id="live-detail-${key}" style="display:${expanded ? '' : 'none'};">${renderPanel(t.name)}</div>`;
  };
  return matchups
    .map((mu) => {
      const [t1, t2] = mu.teams;
      // Highlight whoever currently leads the matchup (missing data counts as 0; ties — or
      // nothing scored yet — highlight nobody). Purely visual: official winners are decided
      // at round finalization on the Scoreboard bracket, seed tiebreak included.
      const e1 = byName[t1.name] ? (byName[t1.name].round_total ?? 0) : 0;
      const e2 = byName[t2.name] ? (byName[t2.name].round_total ?? 0) : 0;
      const leader = e1 !== e2 ? (e1 > e2 ? t1.name : t2.name) : null;
      return `<div class="live-matchup">
        <div class="live-matchup-label">${esc(mu.label)}</div>
        ${teamHtml(t1, leader === t1.name)}
        ${teamHtml(t2, leader === t2.name)}
      </div>`;
    })
    .join('');
}

// Signed fixed-2 number for the live matchup sublines ("+8.40" / "-3.10").
function fmtSignedLive(v) {
  const n = v ?? 0;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function startLivePolling() {
  stopLivePolling();
  _liveViewDate = null;
  updateLiveDateNav();
  // Always do an initial fetch on entering the tab; the response decides whether
  // to schedule a follow-up poll.
  refreshLive();
}

function stopLivePolling() {
  if (_livePollTimer) {
    clearTimeout(_livePollTimer);
    _livePollTimer = null;
  }
}

function updateLiveDateNav() {
  const prevBtn = document.getElementById('live-date-prev');
  const nextBtn = document.getElementById('live-date-next');
  const labelEl = document.getElementById('live-date-label');
  if (!prevBtn || !nextBtn || !labelEl) return;
  // Bound the nav by the live day, not the calendar date: during the hold-over window the live
  // view already IS the previous date, so stepping "forward" to the calendar date would land on a
  // day whose games haven't started — and the historical endpoint has nothing for it yet.
  const liveDay = liveDayET();
  if (_liveViewDate === null) {
    // Calling last night's slate "Today" during the hold-over window reads as a bug. Name the
    // day we are actually showing; it flips back to "Today" at the rollover.
    labelEl.textContent = _liveRolloverAt ? fmtShortDate(liveDay) : 'Today';
    nextBtn.disabled = true;
  } else {
    labelEl.textContent = _liveViewDate;
    nextBtn.disabled = _liveViewDate >= liveDay;
  }
}

window.liveDatePrev = function () {
  const from = _liveViewDate || liveDayET();
  const d = new Date(from + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  _liveViewDate = d.toISOString().slice(0, 10);
  updateLiveDateNav();
  stopLivePolling();
  fetchDailyHistory(_liveViewDate);
};

window.liveDateNext = function () {
  if (!_liveViewDate) return;
  const liveDay = liveDayET();
  const d = new Date(_liveViewDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const next = d.toISOString().slice(0, 10);
  if (next >= liveDay) {
    // Arrived at the live day — switch back to live polling mode
    _liveViewDate = null;
    updateLiveDateNav();
    startLivePolling();
  } else {
    _liveViewDate = next;
    updateLiveDateNav();
    stopLivePolling();
    fetchDailyHistory(_liveViewDate);
  }
};

async function fetchDailyHistory(date) {
  if (!SELECTED_SEASON) return;
  const statusEl = document.getElementById('live-status');
  if (statusEl) statusEl.textContent = 'Loading…';
  try {
    const resp = await fetch(
      `/api/mlb/daily?year=${encodeURIComponent(SELECTED_SEASON)}&date=${encodeURIComponent(date)}`
    );
    const data = await resp.json();
    renderDailyContent(data);
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  }
}

function renderDailyContent(d) {
  const titleEl = document.getElementById('live-week-title');
  const statusEl = document.getElementById('live-status');
  const managersEl = document.getElementById('live-managers');
  const gamesEl = document.getElementById('live-games');

  if (gamesEl) gamesEl.innerHTML = '';

  if (!d.active_week) {
    if (titleEl) titleEl.textContent = 'Live';
    if (statusEl) {
      statusEl.textContent = d.season_closed
        ? 'The season is over — live scoring is off.'
        : `No schedule week found for ${d.date}.`;
    }
    if (managersEl) managersEl.innerHTML = '';
    return;
  }

  const aw = d.active_week;
  if (titleEl) titleEl.textContent = `${aw.round} · ${aw.week}`;
  if (statusEl) statusEl.textContent = `Showing scores for ${d.date}`;

  if (!managersEl) return;

  const fmtDelta = (delta) => {
    if (!delta || delta === 0) return '<span class="rank-delta-zero">—</span>';
    const sign = delta > 0 ? '+' : '';
    const cls = delta > 0 ? 'rank-delta-up' : 'rank-delta-down';
    return `<span class="${cls}">${sign}${delta}</span>`;
  };

  const playersByMgr = {};
  for (const p of d.players || []) {
    if (!playersByMgr[p.manager]) playersByMgr[p.manager] = { batting: [], pitching: [] };
    playersByMgr[p.manager][p.type].push(p);
  }

  const renderDailyPanel = (managerName) => {
    const data = playersByMgr[managerName] || { batting: [], pitching: [] };
    const batters = [...data.batting].sort((a, b) => b.score - a.score);
    const pitchers = [...data.pitching].sort((a, b) => b.score - a.score);
    if (!batters.length && !pitchers.length) {
      return '<div class="mgr-detail-panel"><div class="live-mgr-detail-empty">No stats recorded for this date.</div></div>';
    }
    const batterRow = (pl) => `<tr>
      <td>${esc(pl.name)}</td>
      <td>${esc(pl.team || '')}</td>
      <td class="num-cell">${pl.stats.abs || 0}</td>
      <td class="num-cell">${pl.stats['1b'] || 0}</td>
      <td class="num-cell">${pl.stats['2b'] || 0}</td>
      <td class="num-cell">${pl.stats['3b'] || 0}</td>
      <td class="num-cell">${pl.stats.hr || 0}</td>
      <td class="num-cell">${pl.stats.r || 0}</td>
      <td class="num-cell">${pl.stats.rbi || 0}</td>
      <td class="num-cell">${pl.stats.sb || 0}</td>
      <td class="num-cell">${pl.stats.bb || 0}</td>
      <td class="num-cell"><strong>${fmt(pl.score)}</strong></td>
    </tr>`;
    const pitcherRow = (pl) => `<tr>
      <td>${esc(pl.name)}</td>
      <td>${esc(pl.team || '')}</td>
      <td class="num-cell">${pl.stats.gs || 0}</td>
      <td class="num-cell">${pl.stats.w || 0}</td>
      <td class="num-cell">${fmtDec(pl.stats.qs || 0)}</td>
      <td class="num-cell">${pl.stats.cg || 0}</td>
      <td class="num-cell">${pl.stats.cgso || 0}</td>
      <td class="num-cell">${pl.stats.nh || 0}</td>
      <td class="num-cell">${fmtDec(pl.stats.ip || 0)}</td>
      <td class="num-cell">${pl.stats.h || 0}</td>
      <td class="num-cell">${pl.stats.er || 0}</td>
      <td class="num-cell">${pl.stats.bb || 0}</td>
      <td class="num-cell">${pl.stats.k || 0}</td>
      <td class="num-cell"><strong>${fmt(pl.score)}</strong></td>
    </tr>`;
    const battingTable = batters.length
      ? `<div class="table-wrapper"><table class="data-table compact-table">
          <thead><tr>
            <th>Player</th><th>Team</th>
            <th class="num-cell">AB</th><th class="num-cell">1B</th><th class="num-cell">2B</th>
            <th class="num-cell">3B</th><th class="num-cell">HR</th><th class="num-cell">R</th>
            <th class="num-cell">RBI</th><th class="num-cell">SB</th><th class="num-cell">BB</th>
            <th class="num-cell">Pts</th>
          </tr></thead>
          <tbody>${batters.map(batterRow).join('')}</tbody>
        </table></div>`
      : '<div class="live-mgr-detail-empty">No batter activity this day.</div>';
    const pitchingTable = pitchers.length
      ? `<div class="table-wrapper"><table class="data-table compact-table">
          <thead><tr>
            <th>Player</th><th>Team</th>
            <th class="num-cell">GS</th><th class="num-cell">W</th><th class="num-cell">QS</th>
            <th class="num-cell">CG</th><th class="num-cell">CGSO</th><th class="num-cell">NH</th>
            <th class="num-cell">IP</th><th class="num-cell">H</th><th class="num-cell">ER</th>
            <th class="num-cell">BB</th><th class="num-cell">K</th><th class="num-cell">Pts</th>
          </tr></thead>
          <tbody>${pitchers.map(pitcherRow).join('')}</tbody>
        </table></div>`
      : '<div class="live-mgr-detail-empty">No pitcher activity this day.</div>';
    return `<div class="mgr-detail-panel">
        <div class="live-mgr-detail-section">
          <div class="mgr-detail-header">Batters Today</div>
          ${battingTable}
        </div>
        <div class="live-mgr-detail-section">
          <div class="mgr-detail-header">Pitchers Today</div>
          ${pitchingTable}
        </div>
      </div>`;
  };

  const byName = {};
  for (const m of d.managers || []) byName[m.name] = m;

  // Playoff rounds render as head-to-head bracket matchups (same pairs as the Playoff
  // Bracket card) instead of a ranked standings table; pool play — and any playoff state
  // where the participants can't be determined yet — keeps the table.
  const dailyMatchups = ['QF', 'SF', 'Finals'].includes(aw.round)
    ? playoffRoundMatchups(getSeasons()[SELECTED_SEASON], aw.round)
    : null;
  if (dailyMatchups) {
    const participantNames = new Set(dailyMatchups.flatMap((mu) => mu.teams.map((t) => t.name)));
    for (const n of [..._liveExpandedManagers]) {
      if (!participantNames.has(n)) _liveExpandedManagers.delete(n);
    }
    const subline = (r) =>
      r
        ? `${fmtSignedLive(r.today_score)} daily &middot; ${(r.running_score ?? 0).toFixed(2)} wk`
        : 'No data for this date';
    managersEl.innerHTML = `
      <div class="card">
        <h3>Playoff Matchups <span class="muted">(${esc(d.date)})</span></h3>
        ${renderLiveMatchupCards(dailyMatchups, byName, renderDailyPanel, subline)}
        <div class="live-matchup-note">Totals are certified ${esc(aw.round)} scoreboard points through end of ${esc(d.date)}. Tap a manager for that day&rsquo;s player stats.</div>
      </div>`;
    return;
  }

  const currentMgrNames = new Set((d.managers || []).map((m) => m.name));
  for (const n of [..._liveExpandedManagers]) {
    if (!currentMgrNames.has(n)) _liveExpandedManagers.delete(n);
  }

  const rows = (d.managers || [])
    .map((m, i) => {
      const key = _liveKey(m.name);
      const expanded = _liveExpandedManagers.has(m.name);
      const arrow = expanded ? '&#9650;' : '&#9660;';
      const safeMgr = jsStr(m.name);
      return `
        <tr class="live-mgr-row" onclick="toggleLiveManagerDetails('${key}','${safeMgr}')">
          <td class="rank-cell">${i + 1}</td>
          <td>${esc(m.name)} <span class="sb-expand-arrow" id="live-arrow-${key}">${arrow}</span></td>
          <td class="num-cell"><strong>${(m.round_total ?? 0).toFixed(2)}</strong></td>
          <td class="num-cell">${fmtDelta(m.rank_delta)}</td>
          <td class="num-cell">${(m.today_score ?? 0).toFixed(2)}</td>
          <td class="num-cell">—</td>
          <td class="num-cell">—</td>
          <td class="num-cell">—</td>
          <td class="num-cell">${(m.running_score ?? 0).toFixed(2)}</td>
        </tr>
        <tr class="live-mgr-detail-row" id="live-detail-${key}" style="display:${expanded ? '' : 'none'};">
          <td colspan="9">${renderDailyPanel(m.name)}</td>
        </tr>`;
    })
    .join('');

  const roundLabel = aw.round || '';
  managersEl.innerHTML = `
    <div class="card">
      <h3>Running Standings <span class="muted">(${esc(d.date)})</span></h3>
      <div class="table-wrapper">
        <table class="data-table compact-table">
          <thead><tr>
            <th>#</th><th>Manager</th>
            <th title="Certified ${esc(roundLabel)} scoreboard total through end of ${esc(d.date)}">Total</th>
            <th title="Rank movement from start to end of ${esc(d.date)}">&Delta; Rank</th>
            <th title="Points accumulated on ${esc(d.date)} only">Daily</th>
            <th title="Not available for historical dates">Live</th>
            <th title="Not available for historical dates">Done</th>
            <th title="Not available for historical dates">Left</th>
            <th title="Running weekly score through ${esc(d.date)}">Weekly</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="9" class="empty">No data for this date.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function shouldKeepPolling(data) {
  // A closed season stops the loop dead rather than winding down through the grace window.
  // The grace exists so a tab stays live between the last out of one game and the first pitch
  // of the next; there is no next one, and the server is answering this endpoint without
  // touching the MLB API at all now.
  if (data?.season_closed) return false;
  const hasLive = (data?.summary?.games_live ?? 0) > 0;
  const withinGrace = Date.now() - _liveLastSawLiveGame < LIVE_GRACE_MS;
  return hasLive || withinGrace;
}

function scheduleNextLivePoll(data) {
  stopLivePolling();
  if (!shouldKeepPolling(data)) {
    // Polling is otherwise done for the night, but during the hold-over window the board is
    // pinned to last night's slate. Wake once at the rollover so a tab left open overnight
    // flips to the new game day on its own instead of showing yesterday all morning.
    if (data?.live_day_is_previous && data.rollover_at) {
      const wait = Date.parse(data.rollover_at) - Date.now();
      if (Number.isFinite(wait) && wait > 0) {
        _livePollTimer = setTimeout(() => refreshLive(), wait + 1000);
      }
    }
    return;
  }
  _livePollTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') refreshLive();
    else scheduleNextLivePoll(data); // tab hidden — re-arm without fetching
  }, LIVE_POLL_MS);
}

async function refreshLive() {
  if (!SELECTED_SEASON) return;
  const statusEl = document.getElementById('live-status');
  if (statusEl) statusEl.textContent = 'Refreshing…';
  try {
    const resp = await fetch(`/api/mlb/live?year=${encodeURIComponent(SELECTED_SEASON)}`);
    const data = await resp.json();
    _liveLastFetchedAt = Date.now();
    if ((data?.summary?.games_live ?? 0) > 0) _liveLastSawLiveGame = Date.now();
    renderLiveContent(data);
    scheduleNextLivePoll(data);
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
    // Retry once at the normal interval even on error so a brief network blip doesn't kill polling.
    stopLivePolling();
    _livePollTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') refreshLive();
    }, LIVE_POLL_MS);
  }
}

function renderLiveContent(d) {
  const titleEl = document.getElementById('live-week-title');
  const statusEl = document.getElementById('live-status');
  const managersEl = document.getElementById('live-managers');
  const gamesEl = document.getElementById('live-games');

  // Adopt the server's live day before rendering — the date nav bounds and the
  // hold-over note both key off it.
  if (d.live_day) {
    _liveDayET = d.live_day;
    _liveRolloverAt = d.live_day_is_previous && d.rollover_at ? Date.parse(d.rollover_at) : null;
    if (_liveViewDate === null) updateLiveDateNav();
  }

  if (!d.active_week) {
    if (titleEl) titleEl.textContent = 'Live';
    if (statusEl) {
      statusEl.textContent = d.season_closed
        ? 'The season is over — live scoring is off.'
        : `No active schedule week for ${d.today}.`;
    }
    if (managersEl) managersEl.innerHTML = '';
    if (gamesEl) gamesEl.innerHTML = '';
    return;
  }

  const aw = d.active_week;
  if (titleEl) titleEl.textContent = `Live — ${aw.round} · ${aw.week}`;
  const s = d.summary || {};
  if (statusEl) {
    const updated = d.fetched_at ? new Date(d.fetched_at).toLocaleTimeString() : '';
    const hasLive = (s.games_live ?? 0) > 0;
    const withinGrace = Date.now() - _liveLastSawLiveGame < LIVE_GRACE_MS;
    let pollNote;
    if (hasLive) pollNote = '· refreshing every 2m';
    else if (withinGrace) {
      const remainingMin = Math.max(1, Math.ceil((LIVE_GRACE_MS - (Date.now() - _liveLastSawLiveGame)) / 60_000));
      pollNote = `· grace window (${remainingMin}m left)`;
    } else {
      pollNote = '· polling paused — no live games';
    }
    // During the hold-over window the board is showing LAST night's slate, which would otherwise
    // look like a stale page on a morning refresh. Say so, and say when it flips over.
    let dayNote = '';
    if (d.live_day_is_previous) {
      const rollover = d.rollover_at
        ? new Date(d.rollover_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null;
      dayNote = ` · showing ${fmtShortDate(d.live_day)}` + (rollover ? ` until today's games load at ${rollover}` : '');
    }
    // fetched_at is when the server actually pulled from MLB, which for a cached snapshot is
    // older than this response. Call out a noticeably old snapshot rather than letting the
    // timestamp read as live-to-the-second.
    const ageNote = d.age_ms > 90_000 ? ` (${Math.round(d.age_ms / 1000)}s old)` : '';
    statusEl.textContent =
      `${s.games_live ?? 0} live · ${s.games_final ?? 0} final · ${s.games_preview ?? 0} upcoming` +
      (updated ? ` · updated ${updated}${ageNote} ${pollNote}` : '') +
      dayNote;
  }

  // Manager standings: round total (incl. live) · weekly · rank delta · daily · today's player counts.
  // Managers with players in live or upcoming-today games get a green name.
  if (managersEl) {
    const fmtDelta = (d) => {
      if (!d || d === 0) return '<span class="rank-delta-zero">—</span>';
      const sign = d > 0 ? '+' : '';
      const cls = d > 0 ? 'rank-delta-up' : 'rank-delta-down';
      return `<span class="${cls}">${sign}${d}</span>`;
    };

    // Roll player rows up by manager, but only those with at least one game today.
    // /api/mlb/live already filters playerRows to rostered-for-active-week players,
    // so this list is the active rostered set actually accumulating stats today.
    const todayDate = d.today;
    const todayByMgr = {};
    for (const p of d.players || []) {
      const todayGames = (p.games || []).filter((g) => g.date === todayDate);
      if (todayGames.length === 0) continue;
      const statsToday = {};
      let scoreToday = 0;
      let liveToday = false;
      let finalToday = false;
      for (const g of todayGames) {
        for (const k of Object.keys(g.stats || {})) {
          statsToday[k] = (statsToday[k] || 0) + (g.stats[k] || 0);
        }
        scoreToday += g.game_score || 0;
        if (g.state === 'Live') liveToday = true;
        if (g.state === 'Final') finalToday = true;
      }
      if (!todayByMgr[p.manager]) todayByMgr[p.manager] = { batting: [], pitching: [] };
      todayByMgr[p.manager][p.type].push({
        name: p.name,
        team: p.team,
        stats: statsToday,
        score: Math.round(scoreToday * 100) / 100,
        liveToday,
        finalToday,
      });
    }

    const batterRow = (pl) => `<tr>
      <td class="${pl.finalToday ? 'player-name-final' : 'player-name-live'}">${esc(pl.name)}</td>
      <td>${esc(pl.team || '')}</td>
      <td class="num-cell">${pl.stats.abs || 0}</td>
      <td class="num-cell">${pl.stats['1b'] || 0}</td>
      <td class="num-cell">${pl.stats['2b'] || 0}</td>
      <td class="num-cell">${pl.stats['3b'] || 0}</td>
      <td class="num-cell">${pl.stats.hr || 0}</td>
      <td class="num-cell">${pl.stats.r || 0}</td>
      <td class="num-cell">${pl.stats.rbi || 0}</td>
      <td class="num-cell">${pl.stats.sb || 0}</td>
      <td class="num-cell">${pl.stats.bb || 0}</td>
      <td class="num-cell"><strong>${fmt(pl.score)}</strong></td>
    </tr>`;

    const pitcherRow = (pl) => `<tr>
      <td class="${pl.finalToday ? 'player-name-final' : 'player-name-live'}">${esc(pl.name)}</td>
      <td>${esc(pl.team || '')}</td>
      <td class="num-cell">${pl.stats.gs || 0}</td>
      <td class="num-cell">${pl.stats.w || 0}</td>
      <td class="num-cell">${fmtDec(pl.stats.qs || 0)}</td>
      <td class="num-cell">${pl.stats.cg || 0}</td>
      <td class="num-cell">${pl.stats.cgso || 0}</td>
      <td class="num-cell">${pl.stats.nh || 0}</td>
      <td class="num-cell">${fmtDec(pl.stats.ip || 0)}</td>
      <td class="num-cell">${pl.stats.h || 0}</td>
      <td class="num-cell">${pl.stats.er || 0}</td>
      <td class="num-cell">${pl.stats.bb || 0}</td>
      <td class="num-cell">${pl.stats.k || 0}</td>
      <td class="num-cell"><strong>${fmt(pl.score)}</strong></td>
    </tr>`;

    const renderTodayPanel = (managerName) => {
      const data = todayByMgr[managerName] || { batting: [], pitching: [] };
      const batters = [...data.batting].sort((a, b) => b.score - a.score);
      const pitchers = [...data.pitching].sort((a, b) => b.score - a.score);
      if (batters.length === 0 && pitchers.length === 0) {
        return '<div class="mgr-detail-panel"><div class="live-mgr-detail-empty">No active rostered players accumulating stats today.</div></div>';
      }
      const battingTable = batters.length
        ? `<div class="table-wrapper"><table class="data-table compact-table">
            <thead><tr>
              <th>Player</th><th>Team</th>
              <th class="num-cell">AB</th><th class="num-cell">1B</th><th class="num-cell">2B</th>
              <th class="num-cell">3B</th><th class="num-cell">HR</th><th class="num-cell">R</th>
              <th class="num-cell">RBI</th><th class="num-cell">SB</th><th class="num-cell">BB</th>
              <th class="num-cell">Pts</th>
            </tr></thead>
            <tbody>${batters.map(batterRow).join('')}</tbody>
          </table></div>`
        : '<div class="live-mgr-detail-empty">No batter activity today.</div>';
      const pitchingTable = pitchers.length
        ? `<div class="table-wrapper"><table class="data-table compact-table">
            <thead><tr>
              <th>Player</th><th>Team</th>
              <th class="num-cell">GS</th><th class="num-cell">W</th><th class="num-cell">QS</th>
              <th class="num-cell">CG</th><th class="num-cell">CGSO</th><th class="num-cell">NH</th>
              <th class="num-cell">IP</th><th class="num-cell">H</th><th class="num-cell">ER</th>
              <th class="num-cell">BB</th><th class="num-cell">K</th><th class="num-cell">Pts</th>
            </tr></thead>
            <tbody>${pitchers.map(pitcherRow).join('')}</tbody>
          </table></div>`
        : '<div class="live-mgr-detail-empty">No pitcher activity today.</div>';
      return `<div class="mgr-detail-panel">
        <div class="live-mgr-detail-section">
          <div class="mgr-detail-header">Batters Today</div>
          ${battingTable}
        </div>
        <div class="live-mgr-detail-section">
          <div class="mgr-detail-header">Pitchers Today</div>
          ${pitchingTable}
        </div>
      </div>`;
    };

    const byName = {};
    for (const m of d.managers || []) byName[m.name] = m;

    // Playoff rounds render as head-to-head bracket matchups (same pairs as the Playoff
    // Bracket card) instead of a ranked standings table; pool play — and any playoff state
    // where the participants can't be determined yet — keeps the table.
    const liveMatchups = ['QF', 'SF', 'Finals'].includes(aw.round)
      ? playoffRoundMatchups(getSeasons()[SELECTED_SEASON], aw.round)
      : null;
    // Once the nightly sync has certified the day on screen, its points are already inside the
    // certified scoreboard total, so Total stops adding them and the Daily figure is banked
    // rather than pending. Label it — otherwise Total and Daily look like they disagree, which
    // is exactly what a double-count would look like.
    const dayBanked = !!d.live_day_certified;
    const dayLabel = d.live_day_is_previous ? fmtShortDate(d.today) : 'today';
    if (liveMatchups) {
      const participantNames = new Set(liveMatchups.flatMap((mu) => mu.teams.map((t) => t.name)));
      for (const n of [..._liveExpandedManagers]) {
        if (!participantNames.has(n)) _liveExpandedManagers.delete(n);
      }
      const subline = (r) =>
        r
          ? `${fmtSignedLive(r.today_score)} ${esc(dayLabel)}${dayBanked ? ' (in total)' : ''} &middot; ${r.players_active ?? 0} live &middot; ${r.players_finished ?? 0} done &middot; ${r.players_remaining ?? 0} left &middot; ${(r.running_score ?? 0).toFixed(2)} wk`
          : 'No roster data yet';
      const matchupNote = dayBanked
        ? `Totals are the certified ${esc(aw.round)} scoreboard. ${esc(dayLabel)}&rsquo;s points are already certified into it, so these match the Scoreboard exactly.`
        : `Totals are the certified ${esc(aw.round)} scoreboard plus ${esc(dayLabel)}&rsquo;s points not yet certified into it.`;
      managersEl.innerHTML = `
        <div class="card">
          <h3>Playoff Matchups</h3>
          ${renderLiveMatchupCards(liveMatchups, byName, renderTodayPanel, subline)}
          <div class="live-matchup-note">${matchupNote} Tap a manager for ${esc(dayLabel)}&rsquo;s player stats.</div>
        </div>`;
    } else {
      // Drop any expanded managers that no longer appear in the response so the
      // Set doesn't grow unbounded across season changes.
      const currentMgrNames = new Set((d.managers || []).map((m) => m.name));
      for (const n of [..._liveExpandedManagers]) {
        if (!currentMgrNames.has(n)) _liveExpandedManagers.delete(n);
      }

      const rows = (d.managers || [])
        .map((m, i) => {
          const nameCls = m.is_active_today ? 'live-mgr-active' : '';
          const key = _liveKey(m.name);
          const expanded = _liveExpandedManagers.has(m.name);
          const arrow = expanded ? '&#9650;' : '&#9660;';
          const safeMgr = jsStr(m.name);
          return `
        <tr class="live-mgr-row" onclick="toggleLiveManagerDetails('${key}','${safeMgr}')">
          <td class="rank-cell">${i + 1}</td>
          <td class="${nameCls}">${esc(m.name)} <span class="sb-expand-arrow" id="live-arrow-${key}">${arrow}</span></td>
          <td class="num-cell"><strong>${(m.round_total ?? 0).toFixed(2)}</strong></td>
          <td class="num-cell">${fmtDelta(m.rank_delta)}</td>
          <td class="num-cell">${(m.today_score ?? 0).toFixed(2)}</td>
          <td class="num-cell">${m.players_active ?? 0}</td>
          <td class="num-cell">${m.players_finished ?? 0}</td>
          <td class="num-cell">${m.players_remaining ?? 0}</td>
          <td class="num-cell">${(m.running_score ?? 0).toFixed(2)}</td>
        </tr>
        <tr class="live-mgr-detail-row" id="live-detail-${key}" style="display:${expanded ? '' : 'none'};">
          <td colspan="9">${renderTodayPanel(m.name)}</td>
        </tr>`;
        })
        .join('');
      const roundLabel = d.active_week?.round || '';
      managersEl.innerHTML = `
      <div class="card">
        <h3>Running Standings</h3>
        <div class="table-wrapper">
          <table class="data-table compact-table">
            <thead><tr>
              <th>#</th><th>Manager</th>
              <th title="Certified ${esc(roundLabel)} scoreboard total + any of ${esc(dayLabel)}'s points not yet certified into it (live weekly does not affect this until the next nightly sync)">Total</th>
              <th title="Rank movement vs the certified scoreboard, given ${esc(dayLabel)}'s not-yet-certified points">&Delta; Rank</th>
              <th title="${dayBanked ? `Points scored ${esc(dayLabel)} — already certified into Total` : `Points scored ${esc(dayLabel)}, added to the certified scoreboard total`}">Daily</th>
              <th title="Rostered players whose team has a live game today">Live</th>
              <th title="Rostered players whose team's games today are final">Done</th>
              <th title="Rostered players whose team has a game today that hasn't started">Left</th>
              <th title="Live weekly score for the active week (visibility only — not reflected in Total until the next nightly sync)">Weekly</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="9" class="empty">No managers with data yet.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    }
  }

  // Today's games
  if (gamesEl) {
    const today = d.today;
    const todays = (d.games || []).filter((g) => g.date === today);
    const teamLabel = (t) => t?.team || t?.team_name || '?';
    const fmtGame = (g) => {
      const stateLabel =
        g.state === 'Live'
          ? `<span class="live-pill live-pill-live">LIVE · ${g.inning_half || ''} ${g.inning || ''}</span>`
          : g.state === 'Final'
            ? '<span class="live-pill live-pill-final">FINAL</span>'
            : `<span class="live-pill live-pill-preview">${g.scheduled_time ? new Date(g.scheduled_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'TBD'}</span>`;
      const away = teamLabel(g.away);
      const home = teamLabel(g.home);
      const scoreLine =
        g.state === 'Live' || g.state === 'Final'
          ? `${away} ${g.away.score ?? 0} @ ${home} ${g.home.score ?? 0}`
          : `${away} @ ${home}`;
      const canExpand = g.state === 'Live' || g.state === 'Final';
      const key = String(g.game_id);
      const expanded = _liveExpandedGames.has(key);
      const arrow = canExpand
        ? `<span class="sb-expand-arrow" id="live-game-arrow-${key}">${expanded ? '&#9650;' : '&#9660;'}</span>`
        : '';
      const rowAttrs = canExpand
        ? `class="live-game-row live-game-clickable" onclick="toggleLiveGameBox('${key}')"`
        : 'class="live-game-row"';
      const detail = canExpand
        ? `<div class="live-game-detail" id="live-game-detail-${key}" style="display:${expanded ? '' : 'none'};"></div>`
        : '';
      return `<div ${rowAttrs}>${stateLabel}<span class="live-game-line">${esc(scoreLine)}</span>${arrow}</div>${detail}`;
    };
    // "Today" is the live day: during the hold-over window these are last night's games, still
    // listed under the date they started on (which is how MLB dates them too).
    const gamesHeading = d.live_day_is_previous ? `${fmtShortDate(today)} Games` : "Today's Games";
    gamesEl.innerHTML = `
      <div class="card">
        <h3>${gamesHeading} <span class="muted">(${today})</span></h3>
        ${todays.length ? todays.map(fmtGame).join('') : '<div class="empty">No games today.</div>'}
      </div>`;

    // Drop any expanded games that aren't in today's set (e.g. day rolled over).
    const todaysIds = new Set(todays.map((g) => String(g.game_id)));
    for (const gp of [..._liveExpandedGames]) {
      if (!todaysIds.has(gp)) _liveExpandedGames.delete(gp);
    }
    // Re-fetch the box for every currently-expanded game so the open panel
    // tracks each 2-minute poll. The fetch is lazy and per-game so a single
    // user looking at one card never costs more than one MLB boxscore call.
    for (const gp of _liveExpandedGames) {
      fetchAndRenderLiveBoxscore(gp);
    }
  }
}

// Toggle the per-game full-boxscore drop-down beneath a Today's Games row.
// On open we kick off a lazy fetch to /api/mlb/live/game/:gamePk and inject
// the result. The expanded set is preserved across renderLiveContent calls
// so the panel survives the 2-minute live poll re-render.
window.toggleLiveGameBox = function (gamePk) {
  const key = String(gamePk);
  const detail = document.getElementById('live-game-detail-' + key);
  const arrow = document.getElementById('live-game-arrow-' + key);
  if (!detail) return;
  if (_liveExpandedGames.has(key)) {
    _liveExpandedGames.delete(key);
    detail.style.display = 'none';
    if (arrow) arrow.innerHTML = '&#9660;';
  } else {
    _liveExpandedGames.add(key);
    detail.style.display = '';
    if (arrow) arrow.innerHTML = '&#9650;';
    fetchAndRenderLiveBoxscore(gamePk);
  }
};

async function fetchAndRenderLiveBoxscore(gamePk) {
  if (!SELECTED_SEASON) return;
  const key = String(gamePk);
  const target = document.getElementById('live-game-detail-' + key);
  if (!target) return;
  // Only show the spinner on the first open; on subsequent poll-driven
  // refreshes leave the existing content in place to avoid a flicker.
  if (!target.dataset.loaded) {
    target.innerHTML = '<div class="live-box-loading">Loading box score…</div>';
  }
  try {
    const resp = await fetch(
      `/api/mlb/live/game/${encodeURIComponent(gamePk)}?year=${encodeURIComponent(SELECTED_SEASON)}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!_liveExpandedGames.has(key)) return; // user collapsed mid-flight
    target.innerHTML = renderLiveBoxscoreHTML(data);
    target.dataset.loaded = '1';
  } catch (e) {
    target.innerHTML = `<div class="live-box-loading">Error loading box score: ${esc(e.message)}</div>`;
  }
}

function renderLiveBoxscoreHTML(d) {
  const renderSide = (sideKey) => {
    const t = (d.teams || {})[sideKey] || {};
    const batters = (d.batting || {})[sideKey] || [];
    const pitchers = (d.pitching || {})[sideKey] || [];

    const heading = `<div class="live-box-team-header">
        ${esc(t.team_name || t.team || sideKey)}
        <span class="muted">${t.runs ?? 0} R · ${t.hits ?? 0} H · ${t.errors ?? 0} E</span>
      </div>`;

    const batterRow = (p) => `<tr class="${p.rostered ? 'live-box-rostered' : ''}">
      <td>${esc(p.name)}${p.manager ? ` <span class="live-box-mgr-tag">${esc(p.manager)}</span>` : ''}</td>
      <td>${esc(p.position || '')}</td>
      <td class="num-cell">${p.stats.abs || 0}</td>
      <td class="num-cell">${p.stats['1b'] || 0}</td>
      <td class="num-cell">${p.stats['2b'] || 0}</td>
      <td class="num-cell">${p.stats['3b'] || 0}</td>
      <td class="num-cell">${p.stats.hr || 0}</td>
      <td class="num-cell">${p.stats.r || 0}</td>
      <td class="num-cell">${p.stats.rbi || 0}</td>
      <td class="num-cell">${p.stats.sb || 0}</td>
      <td class="num-cell">${p.stats.bb || 0}</td>
      <td class="num-cell"><strong>${(p.pts || 0).toFixed(2)}</strong></td>
    </tr>`;

    const pitcherRow = (p) => `<tr class="${p.rostered ? 'live-box-rostered' : ''}">
      <td>${esc(p.name)}${p.manager ? ` <span class="live-box-mgr-tag">${esc(p.manager)}</span>` : ''}</td>
      <td class="num-cell">${fmtDec(p.stats.ip || 0)}</td>
      <td class="num-cell">${p.stats.h || 0}</td>
      <td class="num-cell">${p.stats.er || 0}</td>
      <td class="num-cell">${p.stats.bb || 0}</td>
      <td class="num-cell">${p.stats.k || 0}</td>
      <td class="num-cell">${p.stats.w || 0}</td>
      <td class="num-cell">${p.stats.qs || 0}</td>
      <td class="num-cell">${p.stats.cg || 0}</td>
      <td class="num-cell">${p.stats.cgso || 0}</td>
      <td class="num-cell">${p.stats.nh || 0}</td>
      <td class="num-cell"><strong>${(p.pts || 0).toFixed(2)}</strong></td>
    </tr>`;

    const battingTable = batters.length
      ? `<div class="table-wrapper"><table class="data-table compact-table live-box-table">
          <thead><tr>
            <th>Batter</th><th>Pos</th>
            <th class="num-cell">AB</th><th class="num-cell">1B</th><th class="num-cell">2B</th>
            <th class="num-cell">3B</th><th class="num-cell">HR</th><th class="num-cell">R</th>
            <th class="num-cell">RBI</th><th class="num-cell">SB</th><th class="num-cell">BB</th>
            <th class="num-cell">Pts</th>
          </tr></thead>
          <tbody>${batters.map(batterRow).join('')}</tbody>
        </table></div>`
      : '<div class="live-mgr-detail-empty">No batting activity yet.</div>';

    const pitchingTable = pitchers.length
      ? `<div class="table-wrapper"><table class="data-table compact-table live-box-table">
          <thead><tr>
            <th>Pitcher</th>
            <th class="num-cell">IP</th><th class="num-cell">H</th><th class="num-cell">ER</th>
            <th class="num-cell">BB</th><th class="num-cell">K</th><th class="num-cell">W</th>
            <th class="num-cell">QS</th><th class="num-cell">CG</th><th class="num-cell">CGSO</th>
            <th class="num-cell">NH</th><th class="num-cell">Pts</th>
          </tr></thead>
          <tbody>${pitchers.map(pitcherRow).join('')}</tbody>
        </table></div>`
      : '<div class="live-mgr-detail-empty">No pitching activity yet.</div>';

    return `<div class="live-box-side">
      ${heading}
      <div class="live-box-section-title">Batters</div>
      ${battingTable}
      <div class="live-box-section-title">Pitchers</div>
      ${pitchingTable}
    </div>`;
  };

  return `<div class="live-box-panel">${renderSide('away')}${renderSide('home')}</div>`;
}

// Toggle the today's-stats drop-down for a manager row on the Live tab. Mirrors
// the Scoreboard's toggleManagerDetails interaction, but the panel is rebuilt
// inline by renderLiveContent on each poll, so this only flips visibility and
// the persisted expansion Set (_liveExpandedManagers).
window.toggleLiveManagerDetails = function (mgrKey, managerName) {
  const row = document.getElementById('live-detail-' + mgrKey);
  const arrow = document.getElementById('live-arrow-' + mgrKey);
  if (!row) return;
  if (row.style.display === 'none') {
    row.style.display = '';
    if (arrow) arrow.innerHTML = '&#9650;';
    _liveExpandedManagers.add(managerName);
  } else {
    row.style.display = 'none';
    if (arrow) arrow.innerHTML = '&#9660;';
    _liveExpandedManagers.delete(managerName);
  }
};

// On becoming visible again, only refresh if we're still inside the polling window
// (live games or the 30-min grace period) AND the data is older than the poll
// interval. Otherwise leave the stale data on screen — switching to another tab and
// back will resume polling.
//
// The one exception is a passed rollover: a tab backgrounded overnight is showing a game day
// that is now over, and background timer throttling means the rollover timer armed by
// scheduleNextLivePoll may never have fired. Refresh on sight in that case.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const liveTab = document.querySelector('.nav-btn.active[data-tab="live"]');
    if (!liveTab) return;
    if (_liveRolloverAt && Date.now() >= _liveRolloverAt) {
      refreshLive();
      return;
    }
    const withinGrace = Date.now() - _liveLastSawLiveGame < LIVE_GRACE_MS;
    const stale = Date.now() - _liveLastFetchedAt > LIVE_POLL_MS;
    if (withinGrace && stale) refreshLive();
  });
}

// ============================================================
// SCOREBOARD - Combined Dashboard + Standings
// ============================================================
function renderScoreboard() {
  renderChampionBanner();
  renderScoreboardContent();
}

// The most recent champion crowned BEFORE `year`, from every record we have.
//
// Two sources, and the winner is whichever is LATER, not whichever is checked first: the
// hand-maintained `WMMC_HISTORICAL_RESULTS` table lags by design (adding a finished season to
// it is a deliberate two-file edit), so the season the app itself just closed is routinely
// newer than anything in the table. Checking the table first — which is what this used to do —
// would hand next season's banner the champion from two years ago.
//
// Returns { champion, year } or null.
function previousChampionBefore(year) {
  const target = parseInt(year, 10);
  const candidates = [];

  for (const r of WMMC_HISTORICAL_RESULTS) {
    const y = parseInt(r.year, 10);
    if (y < target && r.champion) candidates.push({ champion: r.champion, year: r.year });
  }

  const seasons = getSeasons() || {};
  for (const [yr, priorSd] of Object.entries(seasons)) {
    if (parseInt(yr, 10) >= target || !priorSd) continue;
    // A season this app closed itself: season_closed.champion is written by POST /close from
    // the server's own bracket math, so it is the same answer the recap crowned.
    if (priorSd.season_closed && priorSd.season_closed.champion) {
      candidates.push({ champion: priorSd.season_closed.champion, year: yr });
      continue;
    }
    const legacyWinner =
      priorSd.status === 'completed' &&
      priorSd.data &&
      priorSd.data.bracket &&
      priorSd.data.bracket.finals &&
      priorSd.data.bracket.finals.winner;
    if (legacyWinner) {
      candidates.push({ champion: legacyWinner, year: yr });
      continue;
    }
    if (priorSd.champion) candidates.push({ champion: priorSd.champion, year: yr });
  }

  if (!candidates.length) return null;
  return candidates.reduce((best, c) => (parseInt(c.year, 10) > parseInt(best.year, 10) ? c : best));
}

function renderChampionBanner() {
  const banner = document.getElementById('champion-banner');
  banner.className = 'champion-banner';

  const sd = (getSeasons() || {})[SELECTED_SEASON];
  const closed = sd && sd.season_closed && sd.season_closed.at ? sd.season_closed : null;
  const seasonComplete = !!(DATA && DATA.bracket && DATA.bracket.finals && DATA.bracket.finals.winner) || !!closed;

  // The champion crowned BY the season being viewed, if it has one. A historical season carries
  // it on its stored bracket; an active season that has been closed carries it on
  // season_closed, which the server wrote from computePlayoffPairs.
  const crowned =
    DATA && DATA.bracket && DATA.bracket.finals && DATA.bracket.finals.winner
      ? DATA.bracket.finals.winner
      : closed
        ? closed.champion
        : null;

  // Whoever held it going in. When this season crowned somebody, that name is the OUTGOING
  // champion and gets struck through above the new one — the banner should read as the title
  // changing hands, not quietly swap one name for another overnight.
  //
  // Scoped to seasons this app closed itself. The archived 2018-2025 seasons predate the
  // feature and their banner has read the same way for years; rendering "New Champion" with a
  // line through somebody on a 2019 archive page is a worse answer than leaving it alone.
  const previous = previousChampionBefore(SELECTED_SEASON);
  const reigningChampion = crowned || (previous && previous.champion) || null;
  const reigningYear = crowned ? SELECTED_SEASON : previous && previous.year;
  const outgoing = closed && crowned && previous && previous.champion !== crowned ? previous : null;

  // Determine footer for in-progress or preseason
  let footerHtml = '';
  if (!seasonComplete) {
    const period = sd ? getCurrentScoringPeriod(sd) : null;
    const between = sd ? getBetweenPeriodsInfo(sd) : null;

    // Season status + period are wrapped in distinct spans (with a short
    // status form in data-short) so the layout can split them: desktop shows
    // them together in the footer; mobile moves the short status under the
    // title and keeps only the period in the footer (see js/mobile.js).
    if (between) {
      // Between periods (e.g. the All-Star break before the Quarterfinals):
      // show the upcoming round's roster deadline and start date instead of a
      // stale "last data week" period label.
      const label = between.isAllStarBreak ? 'All-Star Break' : 'Between Rounds';
      const parts = [];
      if (between.deadline) {
        const dueFmt = between.deadline.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        parts.push(`Rosters due ${dueFmt}`);
      }
      parts.push(`${between.nextRoundName} start ${fmtShortDate(between.nextStart)}`);
      // The label gets its own span: mobile hides it (the short status under the
      // title already reads e.g. "All-Star Break") and lets the details wrap.
      footerHtml =
        `<div class="banner-footer">` +
        `<span class="banner-status" data-short="${label}">${SELECTED_SEASON} Season In Progress</span>` +
        `<span class="banner-sep"> &nbsp;|&nbsp; </span>` +
        `<span class="banner-period banner-period-break"><span class="banner-break-label">${label} — </span>${parts.join(' &middot; ')}</span>` +
        `</div>`;
    } else if (period) {
      // Season has data — show round name + week number
      const weekPart = `Week ${period.weekNum} of ${period.totalRoundWeeks}`;
      footerHtml =
        `<div class="banner-footer">` +
        `<span class="banner-status" data-short="In Progress">${SELECTED_SEASON} Season In Progress</span>` +
        `<span class="banner-sep"> &nbsp;|&nbsp; </span>` +
        `<span class="banner-period">${period.roundName} — ${weekPart}</span>` +
        `</div>`;
    } else {
      // No data yet — preseason
      const dates = sd ? sd.schedule_dates : null;
      let periodHtml = '';
      if (dates && dates[0] && dates[0].start) {
        periodHtml =
          `<span class="banner-sep"> &nbsp;|&nbsp; </span>` +
          `<span class="banner-period">Week 1 starts ${fmtShortDate(dates[0].start)}</span>`;
      }
      footerHtml =
        `<div class="banner-footer">` +
        `<span class="banner-status" data-short="Preseason">${SELECTED_SEASON} Preseason</span>` +
        periodHtml +
        `</div>`;
    }
  }

  // When this season crowned someone, the outgoing holder's name sits above the new one with a
  // line through it. It is the one place in the app where the title visibly changes hands, and
  // it costs a row of small text; showing only the new name loses the whole point of the moment.
  const outgoingHtml = outgoing
    ? `<div class="banner-champ-outgoing" title="${esc(outgoing.year)} champion"><s>${esc(outgoing.champion)}</s></div>`
    : '';
  const rightHtml = reigningChampion
    ? `<div class="banner-right${outgoing ? ' banner-right-handover' : ''}" style="display:flex;align-items:center;gap:0.75rem;">
        <div style="font-size:2.5rem;line-height:1;">&#127942;</div>
        <div>
          <div class="banner-champ-label">${outgoing ? 'New Champion' : 'Reigning Champion'}</div>
          ${outgoingHtml}
          <div class="banner-champ-name">${esc(reigningChampion)}</div>
          <div class="banner-champ-year">${esc(String(reigningYear))} WMMC Champion</div>
        </div>
       </div>`
    : '';

  // Apply custom background if configured
  applyBannerBackground(banner, rightHtml, footerHtml);
}

// The end-of-season announcement card: the champion, big, above everything else on the
// dashboard. Rendered only once the commissioner has closed the season — `sd.season_closed`
// is written by POST /close from the server's own bracket math, the same answer the Slack
// recap crowned, so this card cannot name a different champion than the post did.
//
// The four names come off that record; the scores are re-derived here through the same
// roundBreakdown the Playoff Bracket card uses, so the numbers on this card and the numbers
// on the bracket a few hundred pixels below it are the same numbers.
function renderSeasonChampionAnnouncement(seasonData) {
  const el = document.getElementById('season-champion-announcement');
  if (!el) return;

  const closed =
    seasonData && seasonData.season_closed && seasonData.season_closed.at ? seasonData.season_closed : null;
  if (!closed || !closed.champion) {
    el.innerHTML = '';
    return;
  }

  const rosterLookup = buildRosterLookup(seasonData);
  const weekKeyToStart = buildWeekKeyToStart();
  const finalsTotal = (name) =>
    name ? roundBreakdown(seasonData, name, 'Finals', rosterLookup, weekKeyToStart).total : null;

  const champTotal = finalsTotal(closed.champion);
  const runnerUpTotal = finalsTotal(closed.runner_up);
  const resultLine =
    closed.runner_up && champTotal != null && runnerUpTotal != null
      ? `def. ${esc(closed.runner_up)} ${fmt(champTotal)}&ndash;${fmt(runnerUpTotal)}`
      : '';

  const podium = [
    { place: '2nd', medal: '&#129352;', manager: closed.runner_up },
    { place: '3rd', medal: '&#129353;', manager: closed.third },
    { place: '4th', medal: '', manager: closed.fourth },
  ].filter((p) => p.manager);

  const podiumHtml = podium.length
    ? `<div class="champ-podium">${podium
        .map((p) => {
          const total = finalsTotal(p.manager);
          return `<div class="champ-podium-item">
            <span class="champ-podium-place">${p.medal ? `${p.medal} ` : ''}${p.place}</span>
            <span class="champ-podium-name">${esc(p.manager)}</span>
            ${total != null ? `<span class="champ-podium-score">${fmt(total)}</span>` : ''}
          </div>`;
        })
        .join('')}</div>`
    : '';

  el.innerHTML = `<div class="card champ-announcement">
    <div class="champ-announcement-trophy">&#127942;</div>
    <div class="champ-announcement-label">${esc(String(SELECTED_SEASON))} Whit Merrifield Memorial Cup</div>
    <div class="champ-announcement-name">${esc(closed.champion)}</div>
    ${resultLine ? `<div class="champ-announcement-result">${resultLine}</div>` : ''}
    ${podiumHtml}
    <div class="champ-announcement-foot">Season complete &mdash; final results below.</div>
  </div>`;
}

// Build base banner HTML and apply the custom background (or default gradient)
function applyBannerBackground(banner, rightHtml, footerHtml) {
  if (!BANNER_BG_CONFIG || !BANNER_BG_CONFIG.imageData) {
    // Default gradient banner — clear any inline bg styles
    banner.style.backgroundImage = '';
    banner.style.backgroundSize = '';
    banner.style.backgroundPosition = '';
    banner.classList.remove('has-custom-bg');
    banner.innerHTML = `
      <div class="banner-main">
        <div class="banner-left">
          <div class="banner-title">WMMC ${SELECTED_SEASON}</div>
        </div>
        ${rightHtml}
      </div>
      ${footerHtml}
    `;
    return;
  }

  const { imageData, posX = 50, posY = 50, scale = 1 } = BANNER_BG_CONFIG;
  const bgSize = scale * 100 + '%';
  const bgPos = posX + '% ' + posY + '%';

  banner.style.backgroundImage = `url(${imageData})`;
  banner.style.backgroundSize = bgSize;
  banner.style.backgroundPosition = bgPos;
  banner.style.backgroundRepeat = 'no-repeat';
  banner.classList.add('has-custom-bg');

  // Set initial content immediately without backing so the banner is not blank
  banner.innerHTML = `
    <div class="banner-main">
      <div class="banner-left">
        <div class="banner-title">WMMC ${SELECTED_SEASON}</div>
      </div>
      ${rightHtml}
    </div>
    ${footerHtml}
  `;

  // Then run contrast analysis and update classes if needed
  const bannerW = banner.offsetWidth || 900;
  const bannerH = banner.offsetHeight || 140;
  analyzeImageContrast(imageData, posX, posY, scale, bannerW, bannerH).then(
    ({ leftNeedsBacking, rightNeedsBacking }) => {
      const leftEl = banner.querySelector('.banner-left');
      const rightEl = banner.querySelector('.banner-right');
      if (leftEl && leftNeedsBacking) leftEl.classList.add('text-backing');
      if (rightEl && rightNeedsBacking) rightEl.classList.add('text-backing');
    }
  );
}

// Analyse brightness of left and right halves of the banner image region.
// Returns { leftNeedsBacking, rightNeedsBacking } booleans.
async function analyzeImageContrast(imageDataUrl, posX, posY, scale, bannerW, bannerH) {
  try {
    const img = await loadImage(imageDataUrl);
    const canvas = document.createElement('canvas');
    const sampleW = 400;
    const sampleH = 120;
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Calculate how the image would be rendered at the given scale/position
    const imgAspect = img.width / img.height;
    // Compute the rendered size of the image (mimic CSS background-size: N% cover-ish)
    let renderedW, renderedH;
    const scaleFactor = scale; // e.g. 1.0 = 100% width fill
    renderedW = bannerW * scaleFactor;
    renderedH = renderedW / imgAspect;
    if (renderedH < bannerH * scaleFactor) {
      renderedH = bannerH * scaleFactor;
      renderedW = renderedH * imgAspect;
    }

    // Offset from posX/posY percentages
    const offX = (posX / 100) * (bannerW - renderedW);
    const offY = (posY / 100) * (bannerH - renderedH);

    // Draw a sampleW×sampleH version of the rendered image region
    const sx = -offX * (sampleW / bannerW);
    const sy = -offY * (sampleH / bannerH);
    const sw = renderedW * (sampleW / bannerW);
    const sh = renderedH * (sampleH / bannerH);
    ctx.drawImage(img, sx, sy, sw, sh);

    const leftData = ctx.getImageData(0, 0, sampleW / 2, sampleH).data;
    const rightData = ctx.getImageData(sampleW / 2, 0, sampleW / 2, sampleH).data;

    const leftLuminance = averageLuminance(leftData);
    const rightLuminance = averageLuminance(rightData);

    // White text passes WCAG AA when bg luminance <= 0.18
    // Add some extra headroom — use 0.25 as the threshold
    return {
      leftNeedsBacking: leftLuminance > 0.25,
      rightNeedsBacking: rightLuminance > 0.25,
    };
  } catch (e) {
    // On error, assume backing is needed for safety
    return { leftNeedsBacking: true, rightNeedsBacking: true };
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function averageLuminance(pixelData) {
  let total = 0;
  const pixels = pixelData.length / 4;
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i] / 255;
    const g = pixelData[i + 1] / 255;
    const b = pixelData[i + 2] / 255;
    // Linearise sRGB
    const rL = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    const gL = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    const bL = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
    total += 0.2126 * rL + 0.7152 * gL + 0.0722 * bL;
  }
  return total / pixels;
}

// ---- Banner Background Config API helpers ----

async function loadBannerConfig() {
  try {
    const resp = await fetch('/api/banner-config');
    if (resp.ok) {
      const config = await resp.json();
      BANNER_BG_CONFIG = config;
    }
  } catch (e) {
    // Server unavailable, no custom banner
  }
}

async function saveBannerConfig(config) {
  BANNER_BG_CONFIG = config;
  try {
    const resp = await apiFetch('/api/banner-config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

// ---- Commissioner Banner Background UI ----

function renderBannerBgSection() {
  const fileInput = document.getElementById('banner-bg-file');
  const editor = document.getElementById('banner-bg-editor');
  const preview = document.getElementById('banner-bg-preview');
  const scaleInput = document.getElementById('banner-bg-scale');
  const scaleVal = document.getElementById('banner-bg-scale-val');
  const saveBtn = document.getElementById('banner-bg-save-btn');
  const removeBtn = document.getElementById('banner-bg-remove-btn');
  const status = document.getElementById('banner-bg-status');
  const titlePreview = document.getElementById('bbp-title-preview');

  if (!fileInput) return;

  if (titlePreview) titlePreview.textContent = 'WMMC ' + SELECTED_SEASON;

  // State for the current editing session
  let currentImageData = BANNER_BG_CONFIG ? BANNER_BG_CONFIG.imageData : null;
  let currentPosX = BANNER_BG_CONFIG ? BANNER_BG_CONFIG.posX || 50 : 50;
  let currentPosY = BANNER_BG_CONFIG ? BANNER_BG_CONFIG.posY || 50 : 50;
  let currentScale = BANNER_BG_CONFIG ? BANNER_BG_CONFIG.scale || 1 : 1;

  // Show editor if config already exists
  if (currentImageData) {
    applyPreviewBg(preview, currentImageData, currentPosX, currentPosY, currentScale);
    scaleInput.value = Math.round(currentScale * 100);
    scaleVal.textContent = Math.round(currentScale * 100) + '%';
    editor.style.display = 'block';
  }

  // File input change handler
  fileInput.onchange = function () {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      currentImageData = e.target.result;
      currentPosX = 50;
      currentPosY = 50;
      currentScale = 1;
      scaleInput.value = 100;
      scaleVal.textContent = '100%';
      applyPreviewBg(preview, currentImageData, currentPosX, currentPosY, currentScale);
      editor.style.display = 'block';
      status.textContent = '';
    };
    reader.readAsDataURL(file);
  };

  // Scale slider handler
  scaleInput.oninput = function () {
    currentScale = parseInt(scaleInput.value) / 100;
    scaleVal.textContent = scaleInput.value + '%';
    applyPreviewBg(preview, currentImageData, currentPosX, currentPosY, currentScale);
  };

  // Drag-to-reposition on the preview
  setupBannerPreviewDrag(preview, function (dx, dy) {
    // dx/dy are pixel deltas in preview coordinates (preview is ~600px wide, 140px tall)
    const previewRect = preview.getBoundingClientRect();
    const pW = previewRect.width || 500;
    const pH = previewRect.height || 140;
    // Convert pixel delta to percentage delta
    const dpx = -(dx / pW) * 100;
    const dpy = -(dy / pH) * 100;
    currentPosX = Math.max(0, Math.min(100, currentPosX + dpx));
    currentPosY = Math.max(0, Math.min(100, currentPosY + dpy));
    applyPreviewBg(preview, currentImageData, currentPosX, currentPosY, currentScale);
  });

  // Save button
  saveBtn.onclick = async function () {
    if (!currentImageData) {
      status.innerHTML = '<span style="color:var(--danger)">No image selected.</span>';
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const ok = await saveBannerConfig({
      imageData: currentImageData,
      posX: currentPosX,
      posY: currentPosY,
      scale: currentScale,
    });
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Background';
    if (ok) {
      status.innerHTML = '<span style="color:var(--success)">Background saved! Refresh the dashboard to see it.</span>';
      renderChampionBanner();
    } else {
      status.innerHTML = '<span style="color:var(--danger)">Failed to save. Please try again.</span>';
    }
  };

  // Remove button
  removeBtn.onclick = async function () {
    if (!confirm('Remove the custom banner background?')) return;
    removeBtn.disabled = true;
    removeBtn.textContent = 'Removing…';
    const ok = await saveBannerConfig({ clear: true });
    BANNER_BG_CONFIG = null;
    removeBtn.disabled = false;
    removeBtn.textContent = 'Remove Background';
    currentImageData = null;
    editor.style.display = 'none';
    fileInput.value = '';
    if (ok) {
      status.innerHTML = '<span style="color:var(--success)">Background removed.</span>';
      renderChampionBanner();
    } else {
      status.innerHTML = '<span style="color:var(--danger)">Failed to remove. Please try again.</span>';
    }
  };
}

function applyPreviewBg(previewEl, imageData, posX, posY, scale) {
  if (!imageData) return;
  const bgSize = scale * 100 + '%';
  const bgPos = posX + '% ' + posY + '%';
  previewEl.style.backgroundImage = `url(${imageData})`;
  previewEl.style.backgroundSize = bgSize;
  previewEl.style.backgroundPosition = bgPos;
  previewEl.style.backgroundRepeat = 'no-repeat';
}

function setupBannerPreviewDrag(el, onDelta) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  el.addEventListener('mousedown', function (e) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    onDelta(dx, dy);
  });

  document.addEventListener('mouseup', function () {
    dragging = false;
  });

  // Touch support
  el.addEventListener(
    'touchstart',
    function (e) {
      dragging = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      e.preventDefault();
    },
    { passive: false }
  );

  el.addEventListener(
    'touchmove',
    function (e) {
      if (!dragging) return;
      const dx = e.touches[0].clientX - lastX;
      const dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      onDelta(dx, dy);
      e.preventDefault();
    },
    { passive: false }
  );

  el.addEventListener('touchend', function () {
    dragging = false;
  });
}

function renderScoreboardContent() {
  const container = document.getElementById('scoreboard-content');

  if (!DATA || !DATA.scoreboard) {
    container.innerHTML = '';
    return;
  }

  const leaders = getPoolPlayLeaders();
  const seeding = computePlayoffSeeding(leaders);
  const hasBracket = !!(DATA && DATA.bracket);

  const sd = (getSeasons() || {})[SELECTED_SEASON];
  const currentPeriod = sd ? getCurrentScoringPeriod(sd) : null;
  const currentRoundKey = currentPeriod ? currentPeriod.round : null;
  const currentSectionId = currentRoundKey
    ? currentRoundKey === 'Finals'
      ? 'finals'
      : currentRoundKey.toLowerCase()
    : null;
  const inPoolPlay = currentSectionId === 'pp1' || currentSectionId === 'pp2';

  const hasQF = !!(DATA.bracket && DATA.bracket.qf_matchups);
  const hasSF = !!(DATA.bracket && DATA.bracket.sf_matchups);
  const hasFinals = !!(DATA.bracket && DATA.bracket.finals);

  const ppCollapsed = hasBracket;

  const sections = [
    {
      id: 'pp-overall',
      label: 'Pool Play Overall',
      show: true,
      open: !currentSectionId || inPoolPlay,
      content: renderPPOverallContent(leaders, seeding),
    },
    {
      id: 'pp1',
      label: 'Pool Play 1',
      show: true,
      open: !currentSectionId || currentSectionId === 'pp1',
      content: renderPoolPeriodContent('pp1'),
    },
    {
      id: 'pp2',
      label: 'Pool Play 2',
      show: true,
      open: currentSectionId === 'pp2',
      content: renderPoolPeriodContent('pp2'),
    },
    {
      id: 'qf',
      label: 'Quarterfinals',
      show: hasQF,
      open: currentSectionId === 'qf',
      content: renderQFContent(),
    },
    {
      id: 'sf',
      label: 'Semifinals',
      show: hasSF,
      open: currentSectionId === 'sf',
      content: renderSFContent(),
    },
    {
      id: 'finals',
      label: 'Finals',
      show: hasFinals,
      open: currentSectionId === 'finals',
      content: renderFinalsContent(),
    },
  ];

  let html = `<div class="card scoreboard-card sb-poolplay-section">
    <div class="sb-poolplay-header${ppCollapsed ? ' sb-poolplay-collapsed' : ''}" onclick="togglePoolPlay()">
      <h2 style="margin:0;border:none;padding:0;">Pool Play Scoreboard</h2>
      <span class="sb-section-arrow">▾</span>
    </div>
    <div class="sb-poolplay-body" id="sb-poolplay-body" style="display:${ppCollapsed ? 'none' : 'block'};">
      <div class="highlight-legend sb-color-legend">
        <span class="legend-label">Name Colors:</span>
        <span class="legend-item"><span class="legend-swatch hl-pp1"></span> PP1 Pool Leader</span>
        <span class="legend-item"><span class="legend-swatch hl-pp2"></span> PP2 Pool Leader</span>
        <span class="legend-item"><span class="legend-swatch hl-both"></span> PP1 &amp; PP2 Leader</span>
        <span class="legend-item"><span class="legend-swatch hl-wildcard"></span> Wild Card</span>
      </div>`;

  sections.forEach(({ id, label, show, open, content }) => {
    if (!show) return;
    html += `
      <div class="sb-section${open ? '' : ' sb-section-collapsed'}" id="sb-section-${id}">
        <div class="sb-section-header" onclick="toggleScoreboardSection('${id}')">
          <span class="sb-section-title">${label}</span>
          <span class="sb-section-arrow">▾</span>
        </div>
        <div class="sb-period" id="sb-${id}" style="display:${open ? 'block' : 'none'}">
          ${content}
        </div>
      </div>`;
  });

  html += `    </div>
  </div>`;

  // Awards
  html += renderAwardsContent();

  container.innerHTML = html;
}

window.togglePoolPlay = function () {
  const body = document.getElementById('sb-poolplay-body');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  // The collapsed summary is the inverse of the body: shown only when collapsed.
  const summary = document.getElementById('sb-poolplay-summary');
  if (summary) summary.style.display = hidden ? 'none' : 'flex';
  const header = document.querySelector('.sb-poolplay-header');
  if (header) header.classList.toggle('sb-poolplay-collapsed', !hidden);
};

window.toggleScoreboardSection = function (sectionId) {
  const section = document.getElementById('sb-section-' + sectionId);
  const body = document.getElementById('sb-' + sectionId);
  if (!section || !body) return;
  const isCollapsed = section.classList.contains('sb-section-collapsed');
  section.classList.toggle('sb-section-collapsed', !isCollapsed);
  body.style.display = isCollapsed ? 'block' : 'none';
};

// Collapse/expand a single pool card by clicking its header. Toggles a
// `pool-collapsed` class on the card (CSS hides the body + rotates the arrow);
// also updates the legacy `−/+` button text if one is still present.
window.togglePool = function (poolId) {
  const body = document.getElementById('pool-body-' + poolId);
  if (!body) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  const card = body.closest('.pool-card');
  if (card) card.classList.toggle('pool-collapsed', !isHidden);
  const btn = document.getElementById('pool-btn-' + poolId);
  if (btn) btn.textContent = isHidden ? '−' : '+';
};

// Build the grouped player-breakdown panel for one manager: Batters/Pitchers per scoring
// period, with each player's points rendered as a quick-view button. Shared by the pool-play
// scoreboard rows (via toggleManagerDetails) and the playoff-bracket teams (via
// toggleBracketTeam). `filterKey` is a BREAKDOWN_PERIODS key ('PP1'/'PP2'/'QF'/'SF'/'Finals')
// to scope the panel to a single period, or null to show every period grouped. `idPrefix`
// namespaces the collapsible-subsection element ids so multiple panels can coexist on a page.
// Returns the full `.mgr-detail-panel` element HTML (no table wrapper), ready to drop into a
// container (a `<td>` for the table rows, a `<div>` for the bracket).
function buildManagerDetailPanelHtml(idPrefix, managerName, filterKey) {
  const sd = getSeasons()[SELECTED_SEASON];
  if (!sd) return '<div class="mgr-detail-panel sbmd-grouped"></div>';

  const detailMgrRosterDates = (sd.roster_dates || {})[managerName] || {};
  const battingRows = sd.weekly_batting || [];
  const pitchingRows = sd.weekly_pitching || [];
  const sbScheduleDates = getScheduleDates();
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Group the schedule into scoring periods (PP1, PP2, playoffs). Each period gets its own
  // collapsible subsection so a future-period roster submission (e.g. a PP2 roster submitted
  // before PP2 starts, dated to PP2's first week) never visually bleeds into the current period.
  // `filterKey` scopes the breakdown to that single period's own players/stats.
  const periodInfo = BREAKDOWN_PERIODS.filter((p) => !filterKey || p.key === filterKey)
    .map((p) => {
      const weeks = [];
      let firstStart = null;
      let lastEnd = null;
      SEASON_SCHEDULE.forEach((s, idx) => {
        if (s.round !== p.key) return;
        weeks.push({ schedWeek: s, idx });
        const d = sbScheduleDates && sbScheduleDates[idx];
        if (d) {
          if (!firstStart || d.start < firstStart) firstStart = d.start;
          if (!lastEnd || d.end > lastEnd) lastEnd = d.end;
        }
      });
      return { key: p.key, label: p.label, weeks, firstStart, lastEnd };
    })
    .filter((p) => p.weeks.length > 0);

  // Pick the period to auto-expand: the one whose date window contains today, else the most
  // recently started, else the first. Drives the "auto show the current period" behavior.
  let currentPeriodKey = null;
  for (const p of periodInfo) {
    if (p.firstStart && p.lastEnd && todayISO >= p.firstStart && todayISO <= p.lastEnd) {
      currentPeriodKey = p.key;
      break;
    }
  }
  if (!currentPeriodKey) {
    const started = periodInfo.filter((p) => p.firstStart && p.firstStart <= todayISO);
    if (started.length) currentPeriodKey = started[started.length - 1].key;
    else if (periodInfo.length) currentPeriodKey = periodInfo[0].key;
  }
  // When scoped to a single period (pool-section click or a bracket round), always expand it.
  if (filterKey) currentPeriodKey = filterKey;

  // Per-player date tag clipped to a single period's window, so a player's PP2 add (e.g. 6/08)
  // never renders inside their PP1 subsection. Shows only adds/drops that fall in this period.
  function periodPlayerTag(player, periodStart, periodEnd) {
    // Pair the player's add/drop events into rostered spans, then clip each to this period.
    const events = [];
    for (const players of Object.values(detailMgrRosterDates)) {
      const e = players[player];
      if (!e) continue;
      if (e.add_date) events.push({ date: e.add_date, type: 'add' });
      if (e.drop_date) events.push({ date: e.drop_date, type: 'drop' });
    }
    // Chronological; an add sorts before a drop on a same-day tie.
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === 'add' ? -1 : 1));
    const spans = [];
    let openAdd = null;
    for (const ev of events) {
      if (ev.type === 'add') {
        if (openAdd === null) openAdd = ev.date;
      } else {
        // A drop with no preceding add means the player was rostered from the period start
        // (e.g. an initial-submission player later dropped) — anchor the span at periodStart.
        spans.push([openAdd !== null ? openAdd : periodStart, ev.date]);
        openAdd = null;
      }
    }
    if (openAdd !== null) spans.push([openAdd, null]);

    const parts = [];
    for (const [s, e] of spans) {
      if (e !== null && periodStart && e < periodStart) continue; // span ended before this period
      if (s && periodEnd && s > periodEnd) continue; // span starts after this period
      const cs = s && periodStart && s < periodStart ? periodStart : s; // clip start up to periodStart
      // Only treat a drop as "in this period" when it actually falls inside the window.
      const ce = e !== null && (!periodEnd || e <= periodEnd) && (!periodStart || e >= periodStart) ? e : null;
      // A player rostered from the period start and never dropped within it needs no tag.
      if (ce === null && (!periodStart || !cs || cs <= periodStart)) continue;
      if (!cs) continue;
      parts.push(ce ? `${fmtSlashDate(cs)}–${fmtSlashDate(ce)}` : `${fmtSlashDate(cs)}–`);
    }
    if (parts.length === 0) return '';
    return ` <span class="wrs-hist-tag">${parts.join(', ')}</span>`;
  }

  // Roster status of a player within a period: 'active', 'dropped' or 'scheduled' (an add whose
  // date hasn't arrived yet). Evaluated as of TODAY while the period is still running, so a
  // scheduled swap doesn't read as already applied — the outgoing player stays ungreyed until
  // their drop date and the incoming player is flagged as scheduled until their add date. A
  // finished period is read at its end, a not-yet-started one at its start (an early submission
  // dated to the period's first day is active there, exactly as before).
  function periodStatus(player, periodStart, periodEnd) {
    const asOf =
      periodEnd && todayISO > periodEnd ? periodEnd : periodStart && todayISO < periodStart ? periodStart : todayISO;
    const entries = [];
    for (const players of Object.values(detailMgrRosterDates)) {
      if (players[player]) entries.push(players[player]);
    }
    // Upper-bounded by the period end (as before) so a later period's dates never leak back. No
    // lower bound — an out-of-period add/drop is handled by periodPlayerTag's clipping.
    const scoped = entries.map((e) => ({
      add_date: e.add_date && (!periodEnd || e.add_date <= periodEnd) ? e.add_date : null,
      drop_date: e.drop_date && (!periodEnd || e.drop_date <= periodEnd) ? e.drop_date : null,
    }));
    const status = rosterStatusAsOf(scoped, { asOf });
    return status === 'none' ? 'active' : status; // array-only member (original); treat as active
  }

  // Order players so a swapped-in player sits directly beneath the player he replaced —
  // js/rosterOrder.js is the implementation (bridged onto window via js/index.js).
  const orderPlayersWithSwapChains = (names, scoreByPlayer) =>
    orderWithSwapChains(names, scoreByPlayer, sd.swaps, managerName, (email) => (findManagerByEmail(email) || {}).name);

  // Build one period's Batters or Pitchers table. Per-player points use the same carry-forward
  // subtotal (managerWeekSubtotal + detailOut) that feeds the manager's period totals, so the
  // rows reconcile to the period subtotal — a swapped-in/never-dropped player (a mid-period add
  // not yet carried into later weeks' roster arrays) scores every eligible week, not just one.
  function periodTypeTable(p, rowsArr, playerKey, listKey) {
    const scoreByPlayer = {};
    p.weeks.forEach(({ schedWeek, idx }) => {
      const detail = [];
      managerWeekSubtotal(sd, managerName, schedWeek, idx, rowsArr, playerKey, listKey, detail);
      detail.forEach(({ player, score }) => {
        scoreByPlayer[player] = (scoreByPlayer[player] || 0) + (score || 0);
      });
    });
    const names = Object.keys(scoreByPlayer);
    let total = 0;
    names.forEach((n) => (total += scoreByPlayer[n] || 0));
    total = Math.round(total * 100) / 100;
    const typeArg = playerKey === 'batter' ? 'batting' : 'pitching';
    const safeMgr = jsStr(managerName);
    const body =
      names.length === 0
        ? '<tr><td colspan="2" class="text-muted" style="font-size:0.82rem;">None</td></tr>'
        : orderPlayersWithSwapChains(names, scoreByPlayer)
            .map((name) => {
              const pts = Math.round((scoreByPlayer[name] || 0) * 100) / 100;
              const status = periodStatus(name, p.firstStart, p.lastEnd);
              const rowCls = status === 'dropped' ? 'dropped-player' : status === 'scheduled' ? 'scheduled-player' : '';
              const tag =
                periodPlayerTag(name, p.firstStart, p.lastEnd) +
                (status === 'scheduled' ? ' <span class="sched-pill">Scheduled</span>' : '');
              const safeName = jsStr(name);
              return `<tr class="${rowCls}">
        <td>${displayPlayer(name, sd)}${tag}</td>
        <td class="num"><button class="pqv-pts-btn" onclick="showPlayerQuickView('${safeName}','${typeArg}','${safeMgr}')"><strong>${fmt(pts)}</strong></button></td>
      </tr>`;
            })
            .join('');
    return { total, count: names.length, body };
  }

  let panelHtml = '';
  let anyPeriod = false;
  periodInfo.forEach((p) => {
    const bat = periodTypeTable(p, battingRows, 'batter', 'batters');
    const pit = periodTypeTable(p, pitchingRows, 'pitcher', 'pitchers');
    if (bat.count === 0 && pit.count === 0) return; // skip periods this manager has no roster in
    anyPeriod = true;
    const periodTotal = Math.round((bat.total + pit.total) * 100) / 100;
    const isCurrent = p.key === currentPeriodKey;
    const secId = `sbmd-${idPrefix}-${p.key}`;
    panelHtml += `<div class="sbmd-period${isCurrent ? ' sbmd-current' : ''}">
      <div class="sbmd-period-header" onclick="toggleSbmdPeriod('${secId}')">
        <span class="sbmd-period-label">${esc(p.label)}${isCurrent ? ' <span class="sbmd-current-badge">Current</span>' : ''}</span>
        <span class="sbmd-period-pts">${fmt(periodTotal)} pts</span>
      </div>
      <div class="sbmd-period-body" id="${secId}" style="display:${isCurrent ? 'block' : 'none'};">
        <div class="mgr-detail-cols">
          <div class="mgr-detail-section">
            <div class="mgr-detail-header">Batters <span class="sbmd-subtotal">${fmt(bat.total)}</span></div>
            <table class="data-table compact-table"><thead><tr><th>Player</th><th>Pts</th></tr></thead>
            <tbody>${bat.body}</tbody></table>
          </div>
          <div class="mgr-detail-section">
            <div class="mgr-detail-header">Pitchers <span class="sbmd-subtotal">${fmt(pit.total)}</span></div>
            <table class="data-table compact-table"><thead><tr><th>Player</th><th>Pts</th></tr></thead>
            <tbody>${pit.body}</tbody></table>
          </div>
        </div>
      </div>
    </div>`;
  });
  if (!anyPeriod) panelHtml = '<div class="text-muted" style="padding:0.5rem;">No roster data yet.</div>';

  return `<div class="mgr-detail-panel sbmd-grouped">${panelHtml}</div>`;
}

// Toggle the manager player detail pop-down in the pool-play scoreboard. `periodFilter` scopes
// the breakdown to a single scoring period ('pp1'/'pp2') when clicked from that period's own
// section; omitted (Pool Play Overall) shows every period grouped.
window.toggleManagerDetails = function (mgrKey, managerName, periodFilter) {
  const row = document.getElementById('mgr-detail-' + mgrKey);
  const arrow = document.getElementById('sb-arrow-' + mgrKey);
  if (!row) return;

  if (row.style.display !== 'none') {
    row.style.display = 'none';
    if (arrow) arrow.innerHTML = '&#9660;';
    return;
  }

  const filterKey = periodFilter && periodFilter !== 'overall' ? periodFilter.toUpperCase() : null;
  const colspan = row.querySelector('td').getAttribute('colspan') || '6';
  row.innerHTML = `<td colspan="${colspan}">${buildManagerDetailPanelHtml(mgrKey, managerName, filterKey)}</td>`;

  row.style.display = '';
  if (arrow) arrow.innerHTML = '&#9650;';
};

// Expand/collapse a single playoff-bracket team to show that round's player breakdown, mirroring
// the pool-play row expansion. `round` is the exact BREAKDOWN_PERIODS key ('QF'/'SF'/'Finals').
window.toggleBracketTeam = function (detailId, managerName, round) {
  const panel = document.getElementById(detailId);
  if (!panel) return;
  const arrow = document.getElementById(detailId + '-arrow');

  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    if (arrow) arrow.innerHTML = '&#9660;';
    return;
  }

  panel.innerHTML = buildManagerDetailPanelHtml(detailId, managerName, round);
  panel.style.display = '';
  if (arrow) arrow.innerHTML = '&#9650;';
};

// Expand/collapse a single period subsection inside a manager's scoreboard detail panel.
window.toggleSbmdPeriod = function (id) {
  const body = document.getElementById(id);
  if (!body) return;
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
};

window.showPlayerQuickView = function (playerName, type, managerName) {
  const sd = getSeasons()[SELECTED_SEASON];
  if (!sd) return;

  const dates = getScheduleDates();
  const isBat = type === 'batting';
  const arr = isBat ? sd.weekly_batting || [] : sd.weekly_pitching || [];
  const playerKey = isBat ? 'batter' : 'pitcher';

  const pqvRosterLookup = buildRosterLookup(sd);
  const pqvWeekKeyToStart = {};
  SEASON_SCHEDULE.forEach((s, i) => {
    if (dates && dates[i]) pqvWeekKeyToStart[`${s.round}|${s.week}`] = dates[i].start;
  });
  const records = arr
    .filter((r) => {
      if (r[playerKey] !== playerName) return false;
      return weeklyRowOwner(sd, pqvRosterLookup, pqvWeekKeyToStart, r, playerKey) === managerName;
    })
    .sort((a, b) => weekIndexFromKey(a.round, a.week) - weekIndexFromKey(b.round, b.week));

  let tableHtml;
  if (records.length === 0) {
    tableHtml = '<p class="text-muted" style="font-size:0.85rem;margin:0;">No stats recorded.</p>';
  } else if (isBat) {
    let totAbs = 0,
      tot1b = 0,
      tot2b = 0,
      tot3b = 0,
      totHr = 0,
      totR = 0,
      totRbi = 0,
      totSb = 0,
      totBb = 0,
      totPts = 0;
    const rows = records
      .map((r) => {
        const wi = weekIndexFromKey(r.round, r.week);
        const ds = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
        totAbs += r.abs || 0;
        tot1b += r['1b'] || 0;
        tot2b += r['2b'] || 0;
        tot3b += r['3b'] || 0;
        totHr += r.hr || 0;
        totR += r.r || 0;
        totRbi += r.rbi || 0;
        totSb += r.sb || 0;
        totBb += r.bb || 0;
        totPts += r.weekly_score || 0;
        return `<tr>
        <td class="pqv-week">${esc(weekLabel(r.round, r.week))}</td>${dates ? `<td class="week-dates">${ds}</td>` : ''}
        <td class="num">${r.abs || 0}</td><td class="num">${r['1b'] || 0}</td>
        <td class="num">${r['2b'] || 0}</td><td class="num">${r['3b'] || 0}</td>
        <td class="num">${r.hr || 0}</td><td class="num">${r.r || 0}</td>
        <td class="num">${r.rbi || 0}</td><td class="num">${r.sb || 0}</td>
        <td class="num">${r.bb || 0}</td>
        <td class="num"><strong>${fmt(r.weekly_score || 0)}</strong></td>
      </tr>`;
      })
      .join('');
    const totRow =
      records.length > 1
        ? `<tr class="pqv-totals">
        <td><strong>Total</strong></td>${dates ? '<td></td>' : ''}
        <td class="num"><strong>${totAbs}</strong></td><td class="num"><strong>${tot1b}</strong></td>
        <td class="num"><strong>${tot2b}</strong></td><td class="num"><strong>${tot3b}</strong></td>
        <td class="num"><strong>${totHr}</strong></td><td class="num"><strong>${totR}</strong></td>
        <td class="num"><strong>${totRbi}</strong></td><td class="num"><strong>${totSb}</strong></td>
        <td class="num"><strong>${totBb}</strong></td>
        <td class="num"><strong>${fmt(Math.round(totPts * 100) / 100)}</strong></td>
      </tr>`
        : '';
    tableHtml = `<div class="pqv-table-wrap"><table class="data-table compact-table pqv-table">
      <thead><tr><th>Wk</th>${dates ? '<th>Dates</th>' : ''}
        <th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th>
        <th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Pts</th>
      </tr></thead>
      <tbody>${rows}${totRow}</tbody>
    </table></div>`;
  } else {
    let totGs = 0,
      totW = 0,
      totQs = 0,
      totCg = 0,
      totCgso = 0,
      totNh = 0,
      totIp = 0,
      totH = 0,
      totEr = 0,
      totBb = 0,
      totK = 0,
      totPts = 0;
    const rows = records
      .map((r) => {
        const wi = weekIndexFromKey(r.round, r.week);
        const ds = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
        totGs += r.gs || 0;
        totW += r.w || 0;
        totQs += r.qs || 0;
        totCg += r.cg || 0;
        totCgso += r.cgso || 0;
        totNh += r.nh || 0;
        totIp += r.ip || 0;
        totH += r.h || 0;
        totEr += r.er || 0;
        totBb += r.bb || 0;
        totK += r.k || 0;
        totPts += r.weekly_score || 0;
        return `<tr>
        <td class="pqv-week">${esc(weekLabel(r.round, r.week))}</td>${dates ? `<td class="week-dates">${ds}</td>` : ''}
        <td class="num">${r.gs || 0}</td><td class="num">${r.w || 0}</td>
        <td class="num">${fmtDec(r.qs)}</td>
        <td class="num">${r.cg || 0}</td><td class="num">${r.cgso || 0}</td>
        <td class="num">${r.nh || 0}</td><td class="num">${fmtDec(r.ip || 0)}</td>
        <td class="num">${r.h || 0}</td><td class="num">${r.er || 0}</td>
        <td class="num">${r.bb || 0}</td><td class="num">${r.k || 0}</td>
        <td class="num"><strong>${fmt(r.weekly_score || 0)}</strong></td>
      </tr>`;
      })
      .join('');
    const totRow =
      records.length > 1
        ? `<tr class="pqv-totals">
        <td><strong>Total</strong></td>${dates ? '<td></td>' : ''}
        <td class="num"><strong>${totGs}</strong></td><td class="num"><strong>${totW}</strong></td>
        <td class="num"><strong>${fmtDec(totQs)}</strong></td>
        <td class="num"><strong>${totCg}</strong></td><td class="num"><strong>${totCgso}</strong></td>
        <td class="num"><strong>${totNh}</strong></td><td class="num"><strong>${fmtDec(totIp)}</strong></td>
        <td class="num"><strong>${totH}</strong></td><td class="num"><strong>${totEr}</strong></td>
        <td class="num"><strong>${totBb}</strong></td><td class="num"><strong>${totK}</strong></td>
        <td class="num"><strong>${fmt(Math.round(totPts * 100) / 100)}</strong></td>
      </tr>`
        : '';
    tableHtml = `<div class="pqv-table-wrap"><table class="data-table compact-table pqv-table">
      <thead><tr><th>Wk</th>${dates ? '<th>Dates</th>' : ''}
        <th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th>
        <th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Pts</th>
      </tr></thead>
      <tbody>${rows}${totRow}</tbody>
    </table></div>`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'pqv-overlay';
  overlay.innerHTML = `
    <div class="pqv-card" role="dialog" aria-modal="true">
      <div class="pqv-header">
        <div>
          <div class="pqv-title">${playerName}</div>
          <div class="pqv-subtitle">${esc(managerName)} &middot; ${isBat ? 'Batting' : 'Pitching'}</div>
        </div>
        <button class="pqv-close" aria-label="Close">&times;</button>
      </div>
      <div class="pqv-body">${tableHtml}</div>
    </div>`;

  overlay.querySelector('.pqv-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
  });

  document.body.appendChild(overlay);
};

// ---- Pool Play Leaders & Seeding Logic ----

function getPoolPlayLeaders() {
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.pools) {
    return {
      pp1Leaders: new Set(),
      pp2Leaders: new Set(),
      allLeaders: new Set(),
      wildcards: [],
      uniqueLeaderCount: 0,
      wildcardsNeeded: 0,
    };
  }

  const pools = DATA.scoreboard.pools;
  const poolPlay = DATA.scoreboard.pool_play;

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();

  for (const [, members] of Object.entries(pools)) {
    const poolEntries = poolPlay.filter((p) => members.includes(p.manager));

    // PP1 leader - lowest pp1_pool_rank (1 = best)
    const pp1Sorted = [...poolEntries].sort((a, b) => a.pp1_pool_rank - b.pp1_pool_rank);
    if (pp1Sorted.length > 0) pp1Leaders.add(pp1Sorted[0].manager);

    // PP2 leader - lowest pp2_pool_rank (1 = best)
    const pp2Sorted = [...poolEntries].sort((a, b) => a.pp2_pool_rank - b.pp2_pool_rank);
    if (pp2Sorted.length > 0) pp2Leaders.add(pp2Sorted[0].manager);
  }

  const allLeaders = new Set([...pp1Leaders, ...pp2Leaders]);
  const uniqueLeaderCount = allLeaders.size;
  const wildcardsNeeded = Math.max(0, 8 - uniqueLeaderCount);

  // Wildcards: next highest scoring non-leaders
  const nonLeaders = [...poolPlay].filter((p) => !allLeaders.has(p.manager)).sort((a, b) => b.pp_total - a.pp_total);
  const wildcards = nonLeaders.slice(0, wildcardsNeeded).map((p) => p.manager);

  return { pp1Leaders, pp2Leaders, allLeaders, wildcards, uniqueLeaderCount, wildcardsNeeded };
}

function computePlayoffSeeding(leaders) {
  if (!DATA || !DATA.scoreboard) return [];

  const poolPlay = DATA.scoreboard.pool_play;

  // Pool leaders sorted by overall PP score (highest first)
  const poolWinnerEntries = [...leaders.allLeaders]
    .map((name) => poolPlay.find((p) => p.manager === name))
    .filter(Boolean)
    .sort((a, b) => b.pp_total - a.pp_total);

  // Wildcards sorted by overall PP score (highest first)
  const wildcardEntries = leaders.wildcards
    .map((name) => poolPlay.find((p) => p.manager === name))
    .filter(Boolean)
    .sort((a, b) => b.pp_total - a.pp_total);

  const seeded = [...poolWinnerEntries, ...wildcardEntries];
  return seeded.map((p, i) => ({
    ...p,
    seed: i + 1,
    isPoolWinner: leaders.allLeaders.has(p.manager),
    isPP1Leader: leaders.pp1Leaders.has(p.manager),
    isPP2Leader: leaders.pp2Leaders.has(p.manager),
    isWildcard: leaders.wildcards.includes(p.manager),
  }));
}

// ---- Pool Play Period Content (PP1 / PP2) ----

function renderPoolPeriodContent(period) {
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.pools) return '<p>No pool play data available.</p>';

  const pools = DATA.scoreboard.pools;
  const poolPlay = DATA.scoreboard.pool_play;
  const battingKey = period === 'pp1' ? 'pp1_batting' : 'pp2_batting';
  const pitchingKey = period === 'pp1' ? 'pp1_pitching' : 'pp2_pitching';
  const totalKey = period === 'pp1' ? 'pp1_total' : 'pp2_total';
  const rankKey = period === 'pp1' ? 'pp1_pool_rank' : 'pp2_pool_rank';
  const periodLabel = period === 'pp1' ? 'Pool Play 1' : 'Pool Play 2';
  const ppLastMgr = poolPlay.length > 0 ? [...poolPlay].sort((a, b) => a[totalKey] - b[totalKey])[0].manager : null;

  let html = `<div class="pool-period-header">
    <h3>${periodLabel} Standings</h3>
  </div>`;
  html += '<div class="pool-play-grid">';

  for (const [poolName, members] of Object.entries(pools)) {
    const poolEntries = poolPlay.filter((p) => members.includes(p.manager)).sort((a, b) => a[rankKey] - b[rankKey]);
    const safePoolId = `${period}_${poolName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')}`;

    html += `<div class="pool-card">
      <div class="pool-card-header" onclick="togglePool('${safePoolId}')">
        <h4>${poolName}</h4>
        <span class="sb-section-arrow">▾</span>
      </div>
      <div class="pool-card-body" id="pool-body-${safePoolId}">
        <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>
            <th>Rank</th><th>Manager</th><th>Batting</th><th>Pitching</th><th>Total</th>
          </tr></thead>
          <tbody>
            ${poolEntries
              .map(
                (p, i) => `
              <tr class="${i === 0 ? 'pool-leader-row' : ''}">
                <td class="rank">${i + 1}</td>
                <td><strong>${esc(p.manager)}</strong>${p.manager === ppLastMgr ? ' <span class="last-place-icon" title="Last place">🗑️💦</span>' : ''}</td>
                <td class="num">${fmt(p[battingKey])}</td>
                <td class="num">${fmt(p[pitchingKey])}</td>
                <td class="num"><strong>${fmt(p[totalKey])}</strong></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
        </div>
      </div>
    </div>`;
  }

  html += '</div>';
  return html;
}

// ---- Pool Play Overall Content ----

function renderPPOverallContent(leaders, seeding) {
  if (!DATA || !DATA.scoreboard) return '<p>No pool play data available.</p>';

  const poolPlay = [...DATA.scoreboard.pool_play].sort((a, b) => b.pp_total - a.pp_total);
  const lastPlaceMgr = poolPlay.length > 0 ? poolPlay[poolPlay.length - 1].manager : null;

  let html = '<h3>Overall Pool Play Standings</h3>';
  html += '<div class="table-wrapper"><table class="data-table"><thead><tr>';
  html += '<th>Rank</th><th>Manager</th><th>Pool</th><th>PP1 Total</th><th>PP2 Total</th>';
  html += '<th>Batting</th><th>Pitching</th><th>PP Total</th><th>Status</th>';
  html += '</tr></thead><tbody>';

  poolPlay.forEach((p, i) => {
    const pool = getPool(p.manager);
    const isPP1Leader = leaders.pp1Leaders.has(p.manager);
    const isPP2Leader = leaders.pp2Leaders.has(p.manager);
    const isWildcard = leaders.wildcards.includes(p.manager);

    let rowClass = '';
    let statusBadge = '';

    if (isPP1Leader && isPP2Leader) {
      rowClass = 'highlight-both-leader';
      statusBadge = '<span class="badge badge-both">PP1 & PP2 Leader</span>';
    } else if (isPP1Leader) {
      rowClass = 'highlight-pp1-leader';
      statusBadge = '<span class="badge badge-pp1">PP1 Pool Leader</span>';
    } else if (isPP2Leader) {
      rowClass = 'highlight-pp2-leader';
      statusBadge = '<span class="badge badge-pp2">PP2 Pool Leader</span>';
    } else if (isWildcard) {
      rowClass = 'highlight-wildcard';
      statusBadge = '<span class="badge badge-wildcard">Wildcard</span>';
    }

    html += `<tr class="${rowClass}">
      <td class="rank">${i + 1}</td>
      <td><strong>${esc(p.manager)}</strong>${p.manager === lastPlaceMgr ? ' <span class="last-place-icon" title="Last place">🗑️💦</span>' : ''}</td>
      <td>${pool}</td>
      <td class="num">${fmt(p.pp1_total)}</td>
      <td class="num">${fmt(p.pp2_total)}</td>
      <td class="num">${fmt(p.batting_total)}</td>
      <td class="num">${fmt(p.pitching_total)}</td>
      <td class="num"><strong>${fmt(p.pp_total)}</strong></td>
      <td>${statusBadge}</td>
    </tr>`;
  });

  html += '</tbody></table></div>';

  // Legend
  html += `<div class="highlight-legend">
    <span class="legend-item"><span class="legend-swatch swatch-pp1"></span> PP1 Pool Leader (Advances)</span>
    <span class="legend-item"><span class="legend-swatch swatch-pp2"></span> PP2 Pool Leader (Advances)</span>
    <span class="legend-item"><span class="legend-swatch swatch-both"></span> PP1 & PP2 Pool Leader (Advances)</span>
    <span class="legend-item"><span class="legend-swatch swatch-wildcard"></span> Wildcard (Advances)</span>
  </div>`;

  // Advancement explanation
  html += `<div class="advancement-info">
    <p><strong>Advancement:</strong> ${leaders.uniqueLeaderCount} unique pool leaders from PP1 and PP2 automatically advance.
    8 - ${leaders.uniqueLeaderCount} = ${leaders.wildcardsNeeded} wildcard spot${leaders.wildcardsNeeded !== 1 ? 's' : ''} awarded to the next highest scoring non-leader${leaders.wildcardsNeeded !== 1 ? 's' : ''}.</p>
  </div>`;

  // Playoff Seeding
  if (seeding.length > 0) {
    html += '<h3 style="margin-top:1.5rem;">Playoff Seeding</h3>';
    html += '<div class="seeding-list">';
    seeding.forEach((s) => {
      const pool = getPool(s.manager);
      let seedType;
      if (s.isPP1Leader && s.isPP2Leader) seedType = 'PP1 & PP2 Pool Leader';
      else if (s.isPP1Leader) seedType = 'PP1 Pool Leader';
      else if (s.isPP2Leader) seedType = 'PP2 Pool Leader';
      else seedType = 'Wildcard';

      html += `<div class="seed-item">
        <span class="seed-number">${s.seed}</span>
        <span class="seed-manager"><strong>${esc(s.manager)}</strong></span>
        <span class="seed-pool">${pool}</span>
        <span class="seed-type">${seedType}</span>
        <span class="seed-score num">${fmt(s.pp_total)}</span>
      </div>`;
    });
    html += '</div>';

    // Matchup preview
    if (seeding.length >= 8) {
      html += '<h3 style="margin-top:1.5rem;">Quarterfinal Matchups</h3>';
      html += '<div class="matchup-preview-grid">';
      const matchups = [
        { label: 'QF1', s1: seeding[0], s2: seeding[7] },
        { label: 'QF4', s1: seeding[3], s2: seeding[4] },
        { label: 'QF3', s1: seeding[2], s2: seeding[5] },
        { label: 'QF2', s1: seeding[1], s2: seeding[6] },
      ];
      matchups.forEach((m) => {
        html += `<div class="matchup-preview">
          <div class="matchup-label">${m.label}</div>
          <div class="matchup-team">
            <span class="seed">${m.s1.seed}</span>
            <span class="team-name">${m.s1.manager}</span>
          </div>
          <div class="matchup-vs">vs</div>
          <div class="matchup-team">
            <span class="seed">${m.s2.seed}</span>
            <span class="team-name">${m.s2.manager}</span>
          </div>
        </div>`;
      });
      html += '</div>';
    }
  }

  return html;
}

// ---- Quarterfinals Content ----

function renderQFContent() {
  if (!DATA || !DATA.bracket || !DATA.bracket.qf_matchups) return '<p>No quarterfinal data available.</p>';

  let html = '<h3>Quarterfinal Results</h3>';
  html += '<div class="matchup-results-grid">';
  DATA.bracket.qf_matchups.forEach((m) => {
    html += renderMatchupResultCard(m);
  });
  html += '</div>';

  return html;
}

// ---- Semifinals Content ----

function renderSFContent() {
  if (!DATA || !DATA.bracket || !DATA.bracket.sf_matchups) return '<p>No semifinal data available.</p>';

  let html = '<h3>Semifinal Results</h3>';
  html += '<div class="matchup-results-grid">';
  DATA.bracket.sf_matchups.forEach((m) => {
    html += renderMatchupResultCard(m);
  });
  html += '</div>';

  return html;
}

// ---- Finals Content ----

function renderFinalsContent() {
  if (!DATA || !DATA.bracket || !DATA.bracket.finals) return '<p>No finals data available.</p>';

  const f = DATA.bracket.finals;
  let html = '<h3>Championship</h3>';
  html += '<div class="matchup-results-grid">';
  html += renderMatchupResultCard({
    label: 'Finals',
    manager1: f.manager1,
    manager2: f.manager2,
    score1: f.score1,
    score2: f.score2,
    winner: f.winner,
    diff: f.diff,
  });
  html += '</div>';

  if (f.batting1 != null) {
    html += `<div class="finals-detail-grid">
      <div class="finals-detail-card">
        <div class="finals-detail-name">${f.manager1}</div>
        <div class="finals-detail-stats">Batting: ${fmt(f.batting1)} | Pitching: ${fmt(f.pitching1)}</div>
        <div class="finals-detail-total">Total: ${fmt(f.score1)}</div>
      </div>
      <div class="finals-detail-card ${f.winner === f.manager2 ? 'finals-winner' : ''}">
        <div class="finals-detail-name">${f.manager2}</div>
        <div class="finals-detail-stats">Batting: ${fmt(f.batting2)} | Pitching: ${fmt(f.pitching2)}</div>
        <div class="finals-detail-total">Total: ${fmt(f.score2)}</div>
      </div>
    </div>`;
  }

  // 3rd Place
  if (DATA.bracket.consolation) {
    const c = DATA.bracket.consolation;
    html += '<h3 style="margin-top:1.5rem;">3rd Place Game</h3>';
    html += '<div class="matchup-results-grid">';
    html += renderMatchupResultCard({
      label: '3rd Place',
      manager1: c.manager1,
      manager2: c.manager2,
      score1: c.score1,
      score2: c.score2,
      winner: c.winner,
      diff: c.diff,
    });
    html += '</div>';
  }

  return html;
}

// ---- Matchup Result Card ----

// One matchup card, shared by the results lists and the playoff bracket grid.
// `showLabel` lets the bracket suppress the round label on cards whose column already names the
// round; `emptyHtml` is what an absent matchup renders as — nothing in a results list, a TBD
// placeholder in the bracket, where the slot still has to occupy its cell.
function renderMatchupResultCard(m, { showLabel = true, emptyHtml = '' } = {}) {
  if (!m) return emptyHtml;
  const label = showLabel && m.label ? `<div class="matchup-label">${m.label}</div>` : '';
  const w = m.winner;
  return `
    <div class="matchup">
      ${label}
      <div class="matchup-team ${w === m.manager1 ? 'winner' : ''}">
        ${m.seed1 ? `<span class="seed">${m.seed1}</span>` : ''}
        <span class="team-name">${m.manager1}</span>
        <span class="team-score">${m.score1 != null ? fmt(m.score1) : '-'}</span>
      </div>
      <div class="matchup-team ${w === m.manager2 ? 'winner' : ''}">
        ${m.seed2 ? `<span class="seed">${m.seed2}</span>` : ''}
        <span class="team-name">${m.manager2}</span>
        <span class="team-score">${m.score2 != null ? fmt(m.score2) : '-'}</span>
      </div>
    </div>
  `;
}

// ---- Awards Content ----

function renderAwardsContent() {
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.stats) return '';

  const stats = DATA.scoreboard.stats;
  const awards = [
    { label: 'Best PP1 Batting', ...stats.pp1.best_batting },
    { label: 'Best PP1 Pitching', ...stats.pp1.best_pitching },
    { label: 'Best PP2 Batting', ...stats.pp2.best_batting },
    { label: 'Best PP2 Pitching', ...stats.pp2.best_pitching },
    { label: 'Best Overall Batting', ...stats.overall.best_batting },
    { label: 'Best Overall Pitching', ...stats.overall.best_pitching },
    { label: 'Best Single Round', ...stats.overall.best_round },
  ];

  // Add playoff awards if available
  if (stats.quarterfinal) {
    awards.push({ label: 'Best QF Batting', ...stats.quarterfinal.best_batting });
    awards.push({ label: 'Best QF Total', ...stats.quarterfinal.best_total });
  }
  if (stats.semifinal) {
    awards.push({ label: 'Best SF Batting', ...stats.semifinal.best_batting });
    awards.push({ label: 'Best SF Total', ...stats.semifinal.best_total });
  }

  return `<div class="card">
    <h2>Season Awards</h2>
    ${awards
      .map(
        (a) => `
      <div class="award-item">
        <div class="award-label">${a.label}</div>
        <div class="award-value">
          <div class="award-manager">${esc(a.manager)}</div>
          <div class="award-score">${fmt(a.score)}</div>
        </div>
      </div>
    `
      )
      .join('')}
  </div>`;
}

// ---- Weekly Scores ----
// Render the two small "Pool: x/total" / "OVR: x/total" rank rows beneath a
// scored value on the Weekly Team Scoring page. `r` is row.rank[field].
function teamWeeklyRankLines(r) {
  if (!r) return '';
  const pool = r.pool ? `Pool: ${r.pool.rank}/${r.pool.total}` : '';
  const ovr = r.ovr ? `OVR: ${r.ovr.rank}/${r.ovr.total}` : '';
  return `<div class="metric-rank">${pool}</div><div class="metric-rank">${ovr}</div>`;
}

// A single scored metric cell: the value on top, pool + overall ranks beneath.
// `groupStart` marks the left-most metric of a section so it gets a divider.
function teamWeeklyMetricCell(value, rank, strong, groupStart) {
  const val = strong ? `<strong>${fmt(value)}</strong>` : fmt(value);
  const cls = 'metric-cell' + (groupStart ? ' grp-start' : '');
  return `<td class="${cls}"><div class="metric-val">${val}</div>${teamWeeklyRankLines(rank)}</td>`;
}

function renderWeekly() {
  if (!DATA || !DATA.team_weekly) {
    document.getElementById('weekly-table').innerHTML =
      '<tbody><tr><td>No weekly data available for this season.</td></tr></tbody>';
    return;
  }

  // Historical seasons load raw team_weekly rows straight from the season data,
  // which lack the cumulative + rank fields. Enrich them once (idempotent —
  // recomputes from the weekly_* values, so already-enriched rows are unchanged).
  if (DATA.team_weekly.length && !DATA.team_weekly[0].rank) {
    enrichTeamWeekly(DATA.team_weekly);
  }

  // Capture the rows locally: renderActiveWeekly restores the global DATA to null right after
  // this function returns, so the `update` closure (run on every filter change) must not read
  // DATA.team_weekly — it would throw and the filters would silently do nothing.
  const teamWeekly = DATA.team_weekly;

  const rounds = [...new Set(teamWeekly.map((t) => t.round))];
  const weeks = [...new Set(teamWeekly.map((t) => t.week))];
  const managers = [...new Set(teamWeekly.map((t) => t.manager))].sort();

  resetSelect('weekly-round-filter', rounds);
  resetSelect('weekly-week-filter', weeks);
  resetSelect('weekly-manager-filter', managers);

  const update = () => {
    const roundF = document.getElementById('weekly-round-filter').value;
    const weekF = document.getElementById('weekly-week-filter').value;
    const managerF = document.getElementById('weekly-manager-filter').value;

    let filtered = teamWeekly;
    if (roundF !== 'all') filtered = filtered.filter((t) => t.round === roundF);
    if (weekF !== 'all') filtered = filtered.filter((t) => t.week === weekF);
    if (managerF !== 'all') filtered = filtered.filter((t) => t.manager === managerF);

    const dates = getScheduleDates();
    const table = document.getElementById('weekly-table');
    table.classList.add('compact-table');
    table.classList.add('weekly-grouped');
    table.innerHTML = `
      <thead>
        <tr class="group-row">
          <th rowspan="2">Rnd</th><th rowspan="2">Wk</th>${dates ? '<th rowspan="2">Dates</th>' : ''}<th rowspan="2">Manager</th><th rowspan="2">Pool</th>
          <th colspan="3" class="group-weekly">Weekly</th>
          <th colspan="3" class="group-round">Per Round</th>
          <th colspan="3" class="group-overall">Overall</th>
        </tr>
        <tr class="metric-row">
          <th class="group-weekly grp-start">Batting</th><th class="group-weekly">Pitching</th><th class="group-weekly">Total</th>
          <th class="group-round grp-start">Batting</th><th class="group-round">Pitching</th><th class="group-round">Total</th>
          <th class="group-overall grp-start">Batting</th><th class="group-overall">Pitching</th><th class="group-overall">Total</th>
        </tr>
      </thead>
      <tbody>
        ${filtered
          .map((t) => {
            const wi = weekIndexFromKey(t.round, t.week);
            const dateStr = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
            const rk = t.rank || {};
            return `
          <tr>
            <td>${t.round || ''}</td>
            <td>${t.week || ''}</td>
            ${dates ? `<td class="week-dates">${dateStr}</td>` : ''}
            <td><strong>${t.manager}</strong></td>
            <td>${t.pool || ''}</td>
            ${teamWeeklyMetricCell(t.weekly_batting, rk.weekly_batting, false, true)}
            ${teamWeeklyMetricCell(t.weekly_pitching, rk.weekly_pitching)}
            ${teamWeeklyMetricCell(t.weekly_total, rk.weekly_total, true)}
            ${teamWeeklyMetricCell(t.round_batting, rk.round_batting, false, true)}
            ${teamWeeklyMetricCell(t.round_pitching, rk.round_pitching)}
            ${teamWeeklyMetricCell(t.round_total, rk.round_total, true)}
            ${teamWeeklyMetricCell(t.overall_batting, rk.overall_batting, false, true)}
            ${teamWeeklyMetricCell(t.overall_pitching, rk.overall_pitching)}
            ${teamWeeklyMetricCell(t.overall_total, rk.overall_total, true)}
          </tr>
        `;
          })
          .join('')}
      </tbody>
    `;
  };

  document.getElementById('weekly-round-filter').onchange = update;
  document.getElementById('weekly-week-filter').onchange = update;
  document.getElementById('weekly-manager-filter').onchange = update;
  update();
}

// ---- Player Stats ----
function renderPlayers() {
  if (!DATA || !DATA.batting_weekly) {
    document.getElementById('players-table').innerHTML =
      '<tbody><tr><td>No player data available for this season.</td></tr></tbody>';
    return;
  }

  let currentType = 'batting';

  // Capture rows locally: renderActivePlayers restores the global DATA to null right after this
  // returns, so the updatePlayers closure (run on every filter change) must not read DATA.* —
  // it would throw and the filters would silently do nothing.
  const battingWeekly = DATA.batting_weekly;
  const pitchingWeekly = DATA.pitching_weekly;

  const rounds = [...new Set(battingWeekly.map((b) => b.round).concat(pitchingWeekly.map((p) => p.round)))].filter(
    Boolean
  );
  const weeks = [...new Set(battingWeekly.map((b) => b.week).concat(pitchingWeekly.map((p) => p.week)))].filter(
    Boolean
  );
  const managers = [...new Set(battingWeekly.map((b) => b.manager).concat(pitchingWeekly.map((p) => p.manager)))]
    .filter(Boolean)
    .sort();

  resetSelect('player-round-filter', rounds);
  resetSelect('player-week-filter', weeks);
  resetSelect('player-manager-filter', managers);

  const typeBtns = document.querySelectorAll('.type-btn');
  typeBtns.forEach((btn) => {
    if (btn.id && btn.id.startsWith('manual-')) return; // Skip manual update buttons
    btn.onclick = () => {
      typeBtns.forEach((b) => {
        if (b.id && b.id.startsWith('manual-')) return;
        b.classList.remove('active');
      });
      btn.classList.add('active');
      currentType = btn.dataset.type;
      updatePlayers();
    };
  });

  function updatePlayers() {
    const roundF = document.getElementById('player-round-filter').value;
    const weekF = document.getElementById('player-week-filter').value;
    const managerF = document.getElementById('player-manager-filter').value;
    const table = document.getElementById('players-table');
    const dates = getScheduleDates();

    if (currentType === 'batting') {
      let filtered = battingWeekly;
      if (roundF !== 'all') filtered = filtered.filter((b) => b.round === roundF);
      if (weekF !== 'all') filtered = filtered.filter((b) => b.week === weekF);
      if (managerF !== 'all') filtered = filtered.filter((b) => b.manager === managerF);

      table.innerHTML = `
        <thead>
          <tr>
            <th>Week</th>${dates ? '<th>Dates</th>' : ''}<th>Manager</th><th>Batter</th><th>Status</th>
            <th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th>
            <th>R</th><th>RBI</th><th>SB</th><th>BB</th>
            <th>Week Pts</th><th>Total Pts</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((b) => {
              const wi = weekIndexFromKey(b.round, b.week);
              const dateStr = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
              return `
            <tr>
              <td>${esc(weekLabel(b.round, b.week))}</td>
              ${dates ? `<td class="week-dates">${dateStr}</td>` : ''}
              <td><strong>${esc(b.manager)}</strong></td>
              <td>${esc(b.batter)}</td>
              <td>${b.status ? `<span class="swap-type swap-il">${b.status}</span>` : ''}</td>
              <td class="num">${b.abs || 0}</td>
              <td class="num">${b['1b'] || 0}</td>
              <td class="num">${b['2b'] || 0}</td>
              <td class="num">${b['3b'] || 0}</td>
              <td class="num">${b.hr || 0}</td>
              <td class="num">${b.r || 0}</td>
              <td class="num">${b.rbi || 0}</td>
              <td class="num">${b.sb || 0}</td>
              <td class="num">${b.bb || 0}</td>
              <td class="num"><strong>${fmt(b.weekly_score)}</strong></td>
              <td class="num">${fmt(b.total_score)}</td>
            </tr>
          `;
            })
            .join('')}
        </tbody>
      `;
    } else {
      let filtered = pitchingWeekly;
      if (roundF !== 'all') filtered = filtered.filter((p) => p.round === roundF);
      if (weekF !== 'all') filtered = filtered.filter((p) => p.week === weekF);
      if (managerF !== 'all') filtered = filtered.filter((p) => p.manager === managerF);

      table.innerHTML = `
        <thead>
          <tr>
            <th>Week</th>${dates ? '<th>Dates</th>' : ''}<th>Manager</th><th>Pitcher</th><th>Status</th>
            <th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th>
            <th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th>
            <th>Week Pts</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((p) => {
              const wi = weekIndexFromKey(p.round, p.week);
              const dateStr = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
              return `
            <tr>
              <td>${esc(weekLabel(p.round, p.week))}</td>
              ${dates ? `<td class="week-dates">${dateStr}</td>` : ''}
              <td><strong>${esc(p.manager)}</strong></td>
              <td>${esc(p.pitcher)}</td>
              <td>${p.status ? `<span class="swap-type swap-il">${p.status}</span>` : ''}</td>
              <td class="num">${p.gs || 0}</td>
              <td class="num">${p.w || 0}</td>
              <td class="num">${fmtDec(p.qs)}</td>
              <td class="num">${p.cg || 0}</td>
              <td class="num">${p.cgso || 0}</td>
              <td class="num">${p.nh || 0}</td>
              <td class="num">${fmtDec(p.ip)}</td>
              <td class="num">${p.h || 0}</td>
              <td class="num">${p.er || 0}</td>
              <td class="num">${p.bb || 0}</td>
              <td class="num">${p.k || 0}</td>
              <td class="num"><strong>${fmt(p.weekly_score)}</strong></td>
            </tr>
          `;
            })
            .join('')}
        </tbody>
      `;
    }
  }

  document.getElementById('player-round-filter').onchange = updatePlayers;
  document.getElementById('player-week-filter').onchange = updatePlayers;
  document.getElementById('player-manager-filter').onchange = updatePlayers;
  updatePlayers();
}

// ---- Bracket ----

// Order the Scoreboard tab's two containers. Default (index.html) order is the
// scoreboard above the bracket; once playoffs are the focus — pool play finalized
// on an active season, or a historical season with bracket data — the bracket
// moves above so the pool-play summary + full scoreboard tables sit below it.
// Both containers are re-rendered wholesale on every view change, so moving the
// live elements is safe, and season switches restore either order.
function orderScoreboardBracket(bracketFirst) {
  const content = document.getElementById('scoreboard-content');
  const bracket = document.getElementById('scoreboard-bracket');
  if (!content || !bracket || !bracket.parentNode) return;
  if (bracketFirst) {
    if (bracket.nextElementSibling !== content) bracket.parentNode.insertBefore(bracket, content);
  } else if (content.nextElementSibling !== bracket) {
    content.parentNode.insertBefore(content, bracket);
  }
}

function renderBracket() {
  const container = document.getElementById('scoreboard-bracket');
  if (!container) return;
  orderScoreboardBracket(!!(DATA && DATA.bracket));
  if (!DATA || !DATA.bracket) {
    container.innerHTML = '';
    return;
  }

  const b = DATA.bracket;

  const matchupHTML = (m, showLabel) =>
    renderMatchupResultCard(m, {
      showLabel,
      emptyHtml: '<div class="matchup"><div class="matchup-team"><span class="team-name">TBD</span></div></div>',
    });

  container.innerHTML = `<div class="card">
    <h2>Playoff Bracket</h2>
    <div class="bracket-container">
      <div class="bracket-grid">
        <div class="bracket-round">
          <h3>Quarterfinals</h3>
          ${(b.qf_matchups || []).map((m) => matchupHTML(m, true)).join('')}
        </div>
        <div class="bracket-round" style="margin-top: 3rem;">
          <h3>Semifinals</h3>
          ${(b.sf_matchups || []).map((m) => matchupHTML(m, true)).join('')}
        </div>
        <div class="bracket-round" style="margin-top: 6rem;">
          <h3>Finals</h3>
          ${matchupHTML(b.finals, false)}
        </div>
        <div class="bracket-round" style="margin-top: 6rem;">
          <h3>3rd Place</h3>
          ${matchupHTML(b.consolation, false)}
        </div>
      </div>
    </div>
  </div>`;
}

// ---- League Info (Schedule + Scoring + Constitution) ----

// Default constitution/rules text from the WMMC document
const WMMC_DEFAULT_RULES = [
  { heading: true, text: 'Purpose' },
  {
    text: "The Whit Merrifield Memorial Cup is a fantasy baseball game that uses limited rosters and daily fantasy scoring to be played in conjunction with the season-long rotisserie League. The game will consist of a subset of a Franchise's rotisserie League players competing in a Cup format of round robin play followed by an elimination tournament.",
  },
  { heading: true, text: 'Format' },
  {
    text: "The WMMC will start 10 weeks prior to the All-Star Break. Franchises will be organized into pools based on prior year's finishing position.",
  },
  {
    text: "Franchises will be first categorized into Pots based on prior year's finishing position: Pot 1 (1st\u20133rd place), Pot 2 (4th\u20136th), Pot 3 (7th\u20139th), Pot 4 (10th\u201312th). The three players in Pot 1 draft their pools in snake order.",
  },
  { heading: true, text: 'Player Selection' },
  { text: 'Owners will select 4 batters and 3 starting pitchers that will accumulate points for the current round.' },
  { text: 'At the conclusion of each round, players can be swapped in or out.' },
  { text: "If a player is traded or dropped from an owner's team, they must be replaced in WMMC." },
  {
    text: 'Injured players can be replaced if they receive an official IL designation, but cannot be subbed back in until the next round unless they are used to replace another dropped/traded/injured player.',
  },
  { text: 'Each owner is allowed one free player swap per round, in addition to normal status change swaps.' },
  { text: 'For playoff rounds, owners are restricted to one drop swap per round.' },
  { text: 'There are no limits on the number of times a player can be selected.' },
  {
    text: "All replacement player requests must be filed to the Commissioner's office and confirmed by the Commissioner.",
  },
  { heading: true, text: 'Schedule' },
  { text: '10 Weeks from All-Star Break \u2013 Pool Play 1 starts (5 weeks)' },
  { text: '5 Weeks from All-Star Break \u2013 Pool Play 2 starts (5 weeks)' },
  { text: 'Sunday Before All-Star Break \u2013 Pool Play ends (1 week break)' },
  { text: 'Week after All-Star Break \u2013 Quarterfinals (2 weeks)' },
  { text: 'Week after Quarterfinals \u2013 Semifinals (2 weeks)' },
  { text: 'Week after Semifinals \u2013 Finals and 3rd-Place Game (2 weeks each, concurrently)' },
  { heading: true, text: 'Pool Play' },
  { text: 'Each Owner will score points using Daily Fantasy Scoring for two 5 week periods.' },
  { text: 'Owners can select or change players for the second five week period, but the pools will remain the same.' },
  {
    text: "Pool Play Advancement Rules: The winners of PP1 and PP2 per pool automatically advance to the Quarterfinals (up to 6 teams). Top 2 high-scoring non-PP winners are automatically selected as Wildcards. If a pool's PP1 champion is also PP2 champion, the next highest overall scoring team from any pool is selected.",
  },
  { heading: true, text: 'Elimination Play' },
  {
    text: 'After pool play finishes, Owners will be seeded: Pool Play Winners by overall score, then Wildcards by overall score.',
  },
  { text: 'There will be three rounds of two-week single-elimination games: Quarterfinals, Semifinals, and Finals.' },
  {
    text: 'Bracket: 1st vs 8th (QF1), 4th vs 5th (QF2), 3rd vs 6th (QF3), 2nd vs 7th (QF4). QF1 winner vs QF2 winner (SF1), QF3 winner vs QF4 winner (SF2). SF1 winner vs SF2 winner (Final), SF1 loser vs SF2 loser (3rd place).',
  },
  {
    text: 'The bracket will not reseed after each round. Owners use the same lineup/replacement rules during playoffs.',
  },
];

function renderLeagueInfo() {
  renderLeagueSchedule();
  renderLeagueScoring();
  renderLeagueRules();
}

function renderLeagueSchedule() {
  const container = document.getElementById('league-schedule-content');
  if (!container) return;
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  if (!seasonData) {
    container.innerHTML = '';
    return;
  }

  const isActive = seasonData.status === 'active';
  const dates = isActive ? getScheduleDates() : seasonData.schedule_dates || null;
  const uploadedWeeks = new Set();
  if (isActive) {
    (seasonData.weekly_batting || []).forEach((b) => uploadedWeeks.add(`${b.round}|${b.week}`));
  } else if (seasonData.data && seasonData.data.team_weekly) {
    seasonData.data.team_weekly.forEach((t) => uploadedWeeks.add(`${t.round}|${t.week}`));
  }

  let html = `<div class="card"><h2>${SELECTED_SEASON} Season Schedule</h2>`;
  html += '<div class="schedule-timeline">';
  let prevRound = '';
  SEASON_SCHEDULE.forEach((s, i) => {
    const weekKey = `${s.round}|${s.week}`;
    const hasData = uploadedWeeks.has(weekKey);
    const dateStr = dates && dates[i] ? fmtDateRangeShort(dates[i].start, dates[i].end) : '';
    const statusClass = hasData ? 'tl-done' : isActive ? 'tl-pending' : 'tl-empty';

    // Round separator
    if (s.round !== prevRound) {
      // Call out the skipped week between rounds (the All-Star break) with its
      // own dates so the timeline doesn't silently jump from PP2 to the QF.
      if (prevRound && dates) {
        const brk = interRoundBreak(dates[i - 1], dates[i], prevRound, s.round);
        if (brk) {
          html += `<div class="tl-item tl-break">
            <div class="tl-marker"></div>
            <div class="tl-content">
              <span class="tl-week tl-break-label">${brk.label}</span>
              <span class="tl-dates">${fmtDateRangeShort(brk.start, brk.end)}</span>
              <span class="tl-status">Games not scored</span>
            </div>
          </div>`;
        }
      }
      const roundLabels = {
        PP1: 'Pool Play 1',
        PP2: 'Pool Play 2',
        QF: 'Quarterfinals',
        SF: 'Semifinals',
        Finals: 'Finals',
      };
      const periodKey = { PP1: 'pp1', PP2: 'pp2', QF: 'qf', SF: 'sf', Finals: 'finals' }[s.round];
      let windowHtml = '';
      if (periodKey && isActive) {
        const openDate = getPeriodOpenDate(seasonData, periodKey);
        const deadline = getPeriodDeadline(seasonData, periodKey);
        const fmtDt = (d) =>
          d.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
        const parts = [];
        if (openDate) parts.push(`opens <strong>${fmtDt(openDate)}</strong>`);
        if (deadline) parts.push(`closes <strong>${fmtDt(deadline)}</strong>`);
        if (parts.length) {
          windowHtml = `<div class="tl-submission-window">📋 Roster submissions ${parts.join(' &nbsp;·&nbsp; ')}</div>`;
        }
      }
      html += `<div class="tl-round-label">${roundLabels[s.round] || s.round}</div>${windowHtml}`;
      prevRound = s.round;
    }

    html += `<div class="tl-item ${statusClass}">
      <div class="tl-marker"></div>
      <div class="tl-content">
        <span class="tl-week">${s.week}</span>
        ${dateStr ? `<span class="tl-dates">${dateStr}</span>` : ''}
        <span class="tl-status">${hasData ? 'Complete' : isActive ? 'Pending' : ''}</span>
      </div>
    </div>`;
  });
  html += '</div></div>';
  container.innerHTML = html;
}

function renderLeagueScoring() {
  const container = document.getElementById('league-scoring-content');
  if (!container) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const isCommissioner = isLoggedInCommissioner();

  // Use season-level overrides if they exist, otherwise use defaults
  const batScoring = (sd && sd.custom_batting_scoring) || SCORING.batting;
  const pitScoring = (sd && sd.custom_pitching_scoring) || SCORING.pitching;

  const html = `<div class="card">
    <div class="league-section-header">
      <h2>Scoring</h2>
      ${isCommissioner ? '<button class="btn btn-sm btn-outline" onclick="editLeagueScoring()">Edit</button>' : ''}
    </div>
    <div id="league-scoring-display">
      <div class="two-col">
        <div>
          <h3>Batting</h3>
          <table class="data-table scoring-table">
            <thead><tr><th>Category</th><th>Points</th></tr></thead>
            <tbody>
              ${Object.entries(batScoring)
                .map(([k, v]) => `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Pitching</h3>
          <table class="data-table scoring-table">
            <thead><tr><th>Category</th><th>Points</th></tr></thead>
            <tbody>
              ${Object.entries(pitScoring)
                .map(([k, v]) => `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;

  container.innerHTML = html;
}

function renderLeagueRules() {
  const container = document.getElementById('league-rules-content');
  if (!container) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const isCommissioner = isLoggedInCommissioner();

  // Use season-level custom rules if they exist, or historical rules_text, or defaults
  let rules;
  if (sd && sd.custom_rules) {
    rules = sd.custom_rules;
  } else if (DATA && DATA.rules_text) {
    // Convert old format to new format
    const headings = ['Purpose', 'Format', 'Player Selection', 'Schedule', 'Pool Play', 'Elimination Play', 'Scoring'];
    rules = DATA.rules_text
      .filter((line) => line !== 'The Whit Merrifield Memorial Cup')
      .map((line) => (headings.includes(line) ? { heading: true, text: line } : { text: line }));
  } else {
    rules = WMMC_DEFAULT_RULES;
  }

  let rulesHtml = '';
  rules.forEach((r) => {
    if (r.heading) {
      rulesHtml += `<p class="rule-heading">${r.text}</p>`;
    } else {
      rulesHtml += `<p>${r.text}</p>`;
    }
  });

  const html = `<div class="card">
    <div class="league-section-header">
      <h2>Constitution & Rules</h2>
      ${isCommissioner ? '<button class="btn btn-sm btn-outline" onclick="editLeagueRules()">Edit</button>' : ''}
    </div>
    <div id="league-rules-display">${rulesHtml}</div>
  </div>`;

  container.innerHTML = html;
}

// Commissioner: edit scoring values
window.editLeagueScoring = function () {
  const container = document.getElementById('league-scoring-display');
  if (!container) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const batScoring = (sd && sd.custom_batting_scoring) || { ...SCORING.batting };
  const pitScoring = (sd && sd.custom_pitching_scoring) || { ...SCORING.pitching };

  let html = '<div class="two-col">';
  html += '<div><h3>Batting</h3><div class="stat-edit-fields">';
  Object.entries(batScoring).forEach(([k, v]) => {
    html += `<div class="stat-edit-field"><label>${k}</label><input type="number" id="se-bat-${k}" value="${v}" step="0.1"></div>`;
  });
  html += '</div></div>';

  html += '<div><h3>Pitching</h3><div class="stat-edit-fields">';
  Object.entries(pitScoring).forEach(([k, v]) => {
    html += `<div class="stat-edit-field"><label>${k}</label><input type="number" id="se-pit-${k}" value="${v}" step="0.1"></div>`;
  });
  html += '</div></div></div>';

  html += `<div class="stat-edit-actions" style="margin-top:0.75rem;">
    <button class="btn btn-primary" onclick="saveLeagueScoring()">Save Scoring</button>
    <button class="btn btn-secondary" onclick="renderLeagueScoring()">Cancel</button>
  </div>`;

  container.innerHTML = html;
};

window.saveLeagueScoring = function () {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const batScoring = {};
  Object.keys(SCORING.batting).forEach((k) => {
    batScoring[k] = parseFloat(document.getElementById(`se-bat-${k}`).value) || 0;
  });
  const pitScoring = {};
  Object.keys(SCORING.pitching).forEach((k) => {
    pitScoring[k] = parseFloat(document.getElementById(`se-pit-${k}`).value) || 0;
  });

  sd.custom_batting_scoring = batScoring;
  sd.custom_pitching_scoring = pitScoring;
  saveSeason(SELECTED_SEASON, sd);
  renderLeagueScoring();
};

// Commissioner: edit constitution/rules
window.editLeagueRules = function () {
  const container = document.getElementById('league-rules-display');
  if (!container) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];

  // Get current rules as plain text
  let rules;
  if (sd && sd.custom_rules) {
    rules = sd.custom_rules;
  } else if (DATA && DATA.rules_text) {
    const headings = ['Purpose', 'Format', 'Player Selection', 'Schedule', 'Pool Play', 'Elimination Play', 'Scoring'];
    rules = DATA.rules_text
      .filter((line) => line !== 'The Whit Merrifield Memorial Cup')
      .map((line) => (headings.includes(line) ? { heading: true, text: line } : { text: line }));
  } else {
    rules = WMMC_DEFAULT_RULES;
  }

  // Convert to editable text: headings prefixed with ##
  const textLines = rules.map((r) => (r.heading ? `## ${r.text}` : r.text)).join('\n');

  container.innerHTML = `<div>
    <p class="text-muted" style="font-size:0.78rem;margin-bottom:0.5rem;">Lines starting with <strong>##</strong> will be rendered as section headings. All other lines are paragraphs.</p>
    <textarea id="league-rules-editor" class="league-rules-textarea">${textLines}</textarea>
    <div class="stat-edit-actions" style="margin-top:0.5rem;">
      <button class="btn btn-primary" onclick="saveLeagueRules()">Save Rules</button>
      <button class="btn btn-secondary" onclick="renderLeagueRules()">Cancel</button>
    </div>
  </div>`;
};

window.saveLeagueRules = function () {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const text = document.getElementById('league-rules-editor').value;
  const lines = text.split('\n').filter((l) => l.trim());
  sd.custom_rules = lines.map((l) => {
    if (l.startsWith('## ')) return { heading: true, text: l.slice(3).trim() };
    return { text: l.trim() };
  });

  saveSeason(SELECTED_SEASON, sd);
  renderLeagueRules();
};

// ============================================================
// Active Season Display
// ============================================================
function showActiveSeason(seasonData) {
  // Remove players who appear in the Week 1 roster due to a stale initial-submission approval
  // (manager changed their submission after commissioner had already approved an earlier version).
  const ghostsFixed = repairGhostInitialRosterPlayers(seasonData);
  // Repair any data where manager was incorrectly set to MLB team abbreviation
  const assignmentsFixed = repairManagerAssignments(seasonData);
  if (ghostsFixed || assignmentsFixed) {
    saveSeason(SELECTED_SEASON, seasonData);
  }

  // Render the unified champion banner (same layout as historical seasons)
  renderChampionBanner();

  const managers = getManagers();
  const managerScores = computeManagerScores(seasonData);

  // Scoreboard content for active season
  const scoreboardContent = document.getElementById('scoreboard-content');
  if (managerScores.length > 0 || managers.some((m) => m.pool)) {
    scoreboardContent.innerHTML = renderActiveScoreboardTabs(seasonData, managerScores, managers);
  } else {
    // Determine why there are no scores
    const hasUploadedData = (seasonData.weekly_batting || []).length + (seasonData.weekly_pitching || []).length > 0;
    const hasRosters = Object.keys(seasonData.rosters || {}).some((k) => {
      const r = seasonData.rosters[k];
      return (r.batters || []).length > 0 || (r.pitchers || []).length > 0;
    });
    let msg = 'No scoring data yet. Upload weekly stats via the Commissioner page to track scores.';
    if (hasUploadedData && !hasRosters) {
      msg =
        'Player stat data has been uploaded, but no players are assigned to manager rosters yet. ' +
        'Log in as Commissioner on the My Roster page to assign players — scores will appear once rosters are configured.';
    } else if (hasUploadedData && hasRosters) {
      msg =
        'Player stat data has been uploaded and rosters are configured, but no uploaded players match any roster assignment. ' +
        "Check that player names in the uploaded CSV match exactly the names in each manager's roster.";
    }
    scoreboardContent.innerHTML = `<div class="card"><p>${msg}</p></div>`;
  }

  // Render active season weekly/player data
  renderActiveWeekly(seasonData);
  renderActivePlayers(seasonData);

  // Always show playoff bracket on scoreboard
  const finalized = seasonData.finalized_rounds || [];
  const ppFinalized = finalized.includes('PP');

  const bracketContainer = document.getElementById('scoreboard-bracket');
  if (bracketContainer) {
    bracketContainer.innerHTML = buildActivePlayoffBracket(seasonData, ppFinalized);
    // Once pool play is finalized the bracket leads the page; the pool-play
    // summary + full scoreboard move below it (collapsed by default, below).
    orderScoreboardBracket(ppFinalized);

    // If pool play is finalized, minimize pool play section and feature bracket
    if (ppFinalized) {
      const ppBody = document.getElementById('sb-poolplay-body');
      const ppHeader = document.querySelector('.sb-poolplay-header');
      const ppSummary = document.getElementById('sb-poolplay-summary');
      if (ppBody) ppBody.style.display = 'none';
      if (ppHeader) ppHeader.classList.add('sb-poolplay-collapsed');
      if (ppSummary) ppSummary.style.display = 'flex';
    }
  }
}

// Build an active season playoff bracket (tentative or finalized)
function buildActivePlayoffBracket(seasonData, ppFinalized) {
  // Seeding comes entirely from the canonical pool-play computation (single source of truth,
  // drop-aware) — the same function feeds the scoreboard highlights and the qualification
  // gates, so the bracket can't disagree with them and no longer counts dropped players.
  const seeding = getSeeding(seasonData);
  const qualifiers = seeding ? seeding.qualifierNames : [];

  if (qualifiers.length < 8) {
    // Not enough managers to form a bracket
    return `<div class="card"><h2>Playoffs ${!ppFinalized ? '<span class="badge badge-wildcard">Tentative</span>' : ''}</h2>
      <p class="text-muted">Need at least 8 qualifying managers to display the bracket. Currently ${qualifiers.length}.</p></div>`;
  }

  const seeded = qualifiers.slice(0, 8);

  // Build bracket matchups: Top half = 1v8, 4v5 / Bottom half = 3v6, 2v7
  const qfMatchups = [
    { label: 'QF1', s1: { seed: 1, name: seeded[0] }, s2: { seed: 8, name: seeded[7] } },
    { label: 'QF4', s1: { seed: 4, name: seeded[3] }, s2: { seed: 5, name: seeded[4] } },
    { label: 'QF3', s1: { seed: 3, name: seeded[2] }, s2: { seed: 6, name: seeded[5] } },
    { label: 'QF2', s1: { seed: 2, name: seeded[1] }, s2: { seed: 7, name: seeded[6] } },
  ];

  // Round scores + matchup winners use the shared, drop-aware helpers so the bracket agrees
  // with the qualification gates, and ties resolve by the seeding tiebreaker hierarchy.
  const rosterLookup = buildRosterLookup(seasonData);
  const weekKeyToStart = buildWeekKeyToStart();
  const seedRank = seedRankLookup(seasonData);
  const getRoundBreakdown = (manager, round) =>
    roundBreakdown(seasonData, manager, round, rosterLookup, weekKeyToStart);
  function bracketScoreHtml(bd) {
    if (bd.total <= 0) return '<span class="bracket-score">-</span>';
    return `<span class="bracket-score-group">
      <span class="bracket-score">${fmt(bd.total)}</span>
      <span class="bracket-score-detail"><span class="bracket-score-detail-label">B:</span>&nbsp;${fmt(bd.bat)} <span class="bracket-score-detail-label">P:</span>&nbsp;${fmt(bd.pit)}</span>
    </span>`;
  }

  // Render a bracket team row. A real (non-TBD) manager is clickable: clicking expands that
  // round's player breakdown beneath it (same panel as the pool-play rows), and each player's
  // points open the stat quick-view. `seedHtml` is '' for rounds without seeds; `round` is the
  // BREAKDOWN_PERIODS key for this column ('QF'/'SF'/'Finals'); `opponent` is the other name in
  // this matchup, which is what qualifies the odds tag (see advanceOddsHtml).
  function bracketTeamHtml(name, seedHtml, bd, winnerClass, round, opponent) {
    const isReal = name && name !== 'TBD';
    const scoreCell = isReal ? bracketScoreHtml(bd) : '<span class="bracket-score">-</span>';
    if (!isReal) {
      return `<div class="bracket-team ${winnerClass}">${seedHtml}<span class="bracket-name">${esc(name)}</span>${scoreCell}</div>`;
    }
    const detailId = `bracket-detail-${round}-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return `<div class="bracket-team bracket-team-clickable ${winnerClass}" onclick="toggleBracketTeam('${detailId}','${jsStr(name)}','${round}')">
        ${seedHtml}<span class="bracket-name">${esc(name)}</span>${advanceOddsHtml(name, opponent, round)}${scoreCell}
        <span class="sb-expand-arrow bracket-team-arrow" id="${detailId}-arrow">&#9660;</span>
      </div>
      <div class="bracket-team-detail" id="${detailId}" style="display:none;"></div>`;
  }

  const finalized = seasonData.finalized_rounds || [];
  const tentativeLabel = !ppFinalized ? ' <span class="badge badge-wildcard">Tentative</span>' : '';

  // ---- Odds to advance (server-computed, a bracket round's FINAL week only) ----
  // Same contract as the pool-play odds pill: `sd.bracket_odds` is written by the server (4am
  // sync / 7am post / manual recompute) and the client only displays it, so the bracket and the
  // Slack matchup lines can never quote different numbers. The gate mirrors the server's
  // `bracketOddsForPost` exactly — a payload from another day, another round, a round since
  // finalized, or from outside the final-week window is dropped, because a stale % beside a live
  // score is worse than no %.
  const oddsTodayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const bracketOdds = (() => {
    const o = seasonData.bracket_odds;
    if (!o || !o.managers) return null;
    if (o.date !== oddsTodayISO || finalized.includes(o.round)) return null;
    if (!bracketOddsWindowForDate(seasonData.schedule_dates || [], oddsTodayISO)) return null;
    return o;
  })();

  // A % is about ONE matchup, so it renders only where the payload agrees with the pairing this
  // row belongs to: same round, and the same opponent across the line. This card derives its
  // pairs from the seeding plus the prior round's winners while the server derives them from
  // computePlayoffPairs; if those two ever disagree, showing nothing is the correct answer.
  function advanceOddsHtml(name, opponent, round) {
    if (!bracketOdds || bracketOdds.round !== round) return '';
    const o = bracketOdds.managers[name];
    if (!o || o.opponent !== opponent) return '';
    const label = formatOddsPct(o.advance_pct / 100, o.clinched);
    const cls = o.clinched
      ? 'odds-lock'
      : o.advance_pct >= 75
        ? 'odds-high'
        : o.advance_pct >= 25
          ? 'odds-mid'
          : 'odds-low';
    const title = o.clinched
      ? `Matchup decided — ${opponent} has no games left`
      : `Wins this matchup in ${o.advance_pct}% of ${bracketOdds.sims.toLocaleString('en-US')} simulated finishes ` +
        `(games left, projected starts, opponent, park)`;
    return `<span class="odds-pill bracket-odds-pill ${cls}" title="${esc(title)}">${o.clinched ? '&#128274; ' : ''}${label}</span>`;
  }

  // One legend for the whole card, exactly like the Slack section's — eight rows shouldn't each
  // have to explain what the pill is.
  const oddsLegend = bracketOdds
    ? `<p class="bracket-odds-legend">&#128302; % = odds to win this matchup, from ${bracketOdds.sims.toLocaleString('en-US')} simulated finishes (games left, projected starts, opponent, park) &middot; &#128274; = decided</p>`
    : '';

  // Once the season is closed, the bracket opens on the games that decided it: the earlier
  // rounds collapse to a clickable header. Nothing is removed — the whole season is one click
  // away — but a finished bracket's job is to show who won, not to make you scan past eight
  // settled quarterfinal scores to find out.
  const seasonClosed = !!(seasonData.season_closed && seasonData.season_closed.at);
  const roundOpen = (id) => !seasonClosed || id === 'finals';
  const roundColumn = (id, label, inner) => {
    const open = roundOpen(id);
    return `<div class="bracket-round${open ? '' : ' bracket-round-collapsed'}" id="bracket-round-${id}">
      <div class="bracket-round-label" onclick="toggleBracketRound('${id}')">
        <span>${label}</span><span class="bracket-round-arrow">&#9662;</span>
      </div>
      <div class="bracket-round-body" id="bracket-round-body-${id}" style="display:${open ? 'block' : 'none'}">${inner}</div>
    </div>`;
  };

  let html = `<div class="card bracket-card ${ppFinalized ? 'bracket-featured' : ''}">
    <h2>Playoffs${tentativeLabel}</h2>
    ${oddsLegend}
    <div class="active-bracket">`;

  // QF column
  let qfInner = '';
  const qfWinners = [];
  qfMatchups.forEach((m) => {
    const s1Bd = getRoundBreakdown(m.s1.name, 'QF');
    const s2Bd = getRoundBreakdown(m.s2.name, 'QF');
    const qfDone = finalized.includes('QF');
    const winner = qfDone ? roundMatchupWinner(m.s1.name, s1Bd.total, m.s2.name, s2Bd.total, seedRank) : null;
    qfWinners.push(winner);
    qfInner += `<div class="bracket-matchup">
      <div class="bracket-matchup-label">${m.label}</div>
      ${bracketTeamHtml(m.s1.name, `<span class="bracket-seed">${m.s1.seed}</span>`, s1Bd, winner === m.s1.name ? 'bracket-winner' : '', 'QF', m.s2.name)}
      ${bracketTeamHtml(m.s2.name, `<span class="bracket-seed">${m.s2.seed}</span>`, s2Bd, winner === m.s2.name ? 'bracket-winner' : '', 'QF', m.s1.name)}
    </div>`;
  });
  html += roundColumn('qf', 'Quarterfinals', qfInner);

  // SF column
  let sfInner = '';
  const sfMatchups = [
    { label: 'SF1', t1: qfWinners[0] || 'TBD', t2: qfWinners[1] || 'TBD' },
    { label: 'SF2', t1: qfWinners[2] || 'TBD', t2: qfWinners[3] || 'TBD' },
  ];
  const sfWinners = [];
  const sfLosers = [];
  sfMatchups.forEach((m) => {
    const s1Bd = m.t1 !== 'TBD' ? getRoundBreakdown(m.t1, 'SF') : { bat: 0, pit: 0, total: 0 };
    const s2Bd = m.t2 !== 'TBD' ? getRoundBreakdown(m.t2, 'SF') : { bat: 0, pit: 0, total: 0 };
    const sfDone = finalized.includes('SF');
    const winner =
      sfDone && m.t1 !== 'TBD' && m.t2 !== 'TBD'
        ? roundMatchupWinner(m.t1, s1Bd.total, m.t2, s2Bd.total, seedRank)
        : null;
    const loser = winner ? (winner === m.t1 ? m.t2 : m.t1) : null;
    sfWinners.push(winner);
    sfLosers.push(loser);
    sfInner += `<div class="bracket-matchup">
      <div class="bracket-matchup-label">${m.label}</div>
      ${bracketTeamHtml(m.t1, '', s1Bd, winner === m.t1 ? 'bracket-winner' : '', 'SF', m.t2)}
      ${bracketTeamHtml(m.t2, '', s2Bd, winner === m.t2 ? 'bracket-winner' : '', 'SF', m.t1)}
    </div>`;
  });
  html += roundColumn('sf', 'Semifinals', sfInner);

  // Finals column
  let finalsInner = '';
  const f1 = sfWinners[0] || 'TBD';
  const f2 = sfWinners[1] || 'TBD';
  const f1Bd = f1 !== 'TBD' ? getRoundBreakdown(f1, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const f2Bd = f2 !== 'TBD' ? getRoundBreakdown(f2, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const finalsDone = finalized.includes('Finals');
  const champion =
    finalsDone && f1 !== 'TBD' && f2 !== 'TBD' ? roundMatchupWinner(f1, f1Bd.total, f2, f2Bd.total, seedRank) : null;

  finalsInner += `<div class="bracket-matchup">
    <div class="bracket-matchup-label">Championship</div>
    ${bracketTeamHtml(f1, '', f1Bd, champion === f1 ? 'bracket-winner bracket-champion' : '', 'Finals', f2)}
    ${bracketTeamHtml(f2, '', f2Bd, champion === f2 ? 'bracket-winner bracket-champion' : '', 'Finals', f1)}
  </div>`;

  // 3rd Place
  const t1 = sfLosers[0] || 'TBD';
  const t2 = sfLosers[1] || 'TBD';
  const t1Bd = t1 !== 'TBD' ? getRoundBreakdown(t1, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const t2Bd = t2 !== 'TBD' ? getRoundBreakdown(t2, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const thirdPlace = finalsDone && t1 !== 'TBD' && t2 !== 'TBD' ? (t1Bd.total >= t2Bd.total ? t1 : t2) : null;

  finalsInner += `<div class="bracket-matchup" style="margin-top:1rem;">
    <div class="bracket-matchup-label">3rd Place</div>
    ${bracketTeamHtml(t1, '', t1Bd, thirdPlace === t1 ? 'bracket-winner' : '', 'Finals', t2)}
    ${bracketTeamHtml(t2, '', t2Bd, thirdPlace === t2 ? 'bracket-winner' : '', 'Finals', t1)}
  </div>`;

  html += roundColumn('finals', 'Finals', finalsInner);

  html += '</div></div>';
  return html;
}

// Expand/collapse one column of the Playoff Bracket card. Every round starts open; a closed
// season starts with the Quarterfinals and Semifinals shut (see roundColumn).
window.toggleBracketRound = function (roundId) {
  const col = document.getElementById('bracket-round-' + roundId);
  const body = document.getElementById('bracket-round-body-' + roundId);
  if (!col || !body) return;
  const isCollapsed = col.classList.contains('bracket-round-collapsed');
  col.classList.toggle('bracket-round-collapsed', !isCollapsed);
  body.style.display = isCollapsed ? 'block' : 'none';
};

function renderActiveScoreboardTabs(seasonData, managerScores, managers) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const currentPeriod = getCurrentScoringPeriod(seasonData);
  const currentRoundKey = currentPeriod ? currentPeriod.round : null;
  const currentSectionId = currentRoundKey
    ? currentRoundKey === 'Finals'
      ? 'finals'
      : currentRoundKey.toLowerCase()
    : null;

  // Pool groups from manager pool assignments (active managers only)
  const poolGroups = {};
  managers.forEach((m) => {
    if (m.pool && m.active !== false) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });
  const hasPools = Object.keys(poolGroups).length > 0;

  // Compute per-period scores — include ALL pool-assigned managers at 0.
  // Routes through managerWeekSubtotal so each manager's scoreboard total
  // matches their My Roster Pool Play Total exactly (same wasDroppedBefore
  // filter, eligibility set, and manager/null dedup).
  function periodScores(roundFilter) {
    const mgrMap = {};
    managers.forEach((m) => {
      if (m.pool && m.active !== false) mgrMap[m.name] = { manager: m.name, batting: 0, pitching: 0, total: 0 };
    });
    const targetRounds = new Set(roundFilter.map((r) => (r.endsWith('P') ? r.slice(0, -1) : r)));
    SEASON_SCHEDULE.forEach((schedWeek, idx) => {
      if (!targetRounds.has(schedWeek.round)) return;
      for (const m of managers) {
        if (!(m.pool && m.active !== false)) continue;
        const bat = managerWeekSubtotal(seasonData, m.name, schedWeek, idx, batting, 'batter', 'batters');
        const pit = managerWeekSubtotal(seasonData, m.name, schedWeek, idx, pitching, 'pitcher', 'pitchers');
        mgrMap[m.name].batting += bat;
        mgrMap[m.name].pitching += pit;
      }
    });
    return Object.values(mgrMap)
      .map((m) => {
        m.batting = Math.round(m.batting * 100) / 100;
        m.pitching = Math.round(m.pitching * 100) / 100;
        m.total = Math.round((m.batting + m.pitching) * 100) / 100;
        return m;
      })
      .sort((a, b) => b.total - a.total);
  }

  const pp1Scores = periodScores(['PP1', 'PP1P']);
  const pp2Scores = periodScores(['PP2', 'PP2P']);

  // Pool Play Overall = combined PP1 + PP2
  const overallMap = {};
  managers.forEach((m) => {
    if (m.pool && m.active !== false) overallMap[m.name] = { manager: m.name, batting: 0, pitching: 0, total: 0 };
  });
  [...pp1Scores, ...pp2Scores].forEach((s) => {
    if (!overallMap[s.manager]) overallMap[s.manager] = { manager: s.manager, batting: 0, pitching: 0, total: 0 };
    overallMap[s.manager].batting += s.batting;
    overallMap[s.manager].pitching += s.pitching;
  });
  const overallScores = Object.values(overallMap)
    .map((m) => {
      m.batting = Math.round(m.batting * 100) / 100;
      m.pitching = Math.round(m.pitching * 100) / 100;
      m.total = Math.round((m.batting + m.pitching) * 100) / 100;
      return m;
    })
    .sort((a, b) => b.total - a.total);
  const overallLastMgr = overallScores.length > 0 ? overallScores[overallScores.length - 1].manager : null;

  // ---- Pool winners + wildcards from the canonical seeding (single source of truth) ----
  // The same computation feeds the tentative bracket and the qualification gates, so the
  // scoreboard highlights can't disagree with who actually seeds/qualifies. It also scores via
  // managerWeekSubtotal, so the highlighted leaders match the totals shown in these tables.
  const seeding = getSeeding(seasonData) || {
    pp1Leaders: new Set(),
    pp2Leaders: new Set(),
    allLeaders: new Set(),
    wildcardSet: new Set(),
  };
  const pp1WinnerSet = seeding.pp1Leaders;
  const pp2WinnerSet = seeding.pp2Leaders;
  const allPPWinners = seeding.allLeaders;
  const wildcardSet = seeding.wildcardSet;

  // ---- Playoff odds (server-computed Monte-Carlo sim, PP2 Weeks 4–5 only) ----
  // `sd.playoff_odds` is written by the server (4am sync / 7am post / manual
  // recompute) — the client only displays it, so the scoreboard and the Slack
  // post can never disagree. Shown only while the odds window is live and pool
  // play isn't finalized (once it is, the bracket itself is the answer).
  const oddsTodayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const odds =
    !(seasonData.finalized_rounds || []).includes('PP') &&
    seasonData.playoff_odds &&
    seasonData.playoff_odds.managers &&
    oddsWindowForDate(seasonData.schedule_dates || [], oddsTodayISO)
      ? seasonData.playoff_odds
      : null;

  function oddsPill(name) {
    const o = odds && odds.managers[name];
    if (!o) return '';
    const label = formatOddsPct(o.pct / 100, o.locked);
    const cls = o.locked ? 'odds-lock' : o.pct >= 75 ? 'odds-high' : o.pct >= 25 ? 'odds-mid' : 'odds-low';
    const title = o.locked
      ? 'Clinched a playoff spot — PP1 pool winner'
      : `Makes playoffs in ${o.pct}% of simulations (wins PP2 pool ${o.pool_win_pct}%, wild card ${o.wildcard_pct}%)`;
    return `<span class="odds-pill ${cls}" title="${esc(title)}">${o.locked ? '&#128274; ' : ''}${label}</span>`;
  }

  // Highlight class for a manager name in a given section
  function hlClass(name, section) {
    const wonPP1 = pp1WinnerSet.has(name);
    const wonPP2 = pp2WinnerSet.has(name);
    if (section === 'overall') {
      if (wonPP1 && wonPP2) return 'hl-both';
      if (wonPP1) return 'hl-pp1';
      if (wonPP2) return 'hl-pp2';
      if (wildcardSet.has(name)) return 'hl-wildcard';
    } else if (section === 'pp1') {
      if (wonPP1) return 'hl-pp1';
    } else if (section === 'pp2') {
      if (wonPP2) return 'hl-pp2';
    }
    return '';
  }

  // Render pool tables for a section
  function renderPoolSection(scores, title, section) {
    let html = '';
    if (!hasPools) return '<p>No pools configured. Assign managers to pools on the Commissioner page.</p>';
    html += '<div class="pool-play-grid">';
    Object.keys(poolGroups)
      .sort()
      .forEach((poolNum) => {
        const poolMembers = poolGroups[poolNum];
        const poolScores = scores.filter((s) => poolMembers.includes(s.manager)).sort((a, b) => b.total - a.total);
        const safePoolId = `${section}_pool_${String(poolNum)
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9_]/g, '')}`;
        html += `<div class="pool-card">
        <h3>${formatPool(poolNum)}</h3>
        <table class="data-table compact-table">
          <thead><tr><th>#</th><th>Manager</th><th>Bat</th><th>Pit</th><th>Total</th></tr></thead>
          <tbody>`;
        poolScores.forEach((m, i) => {
          const cls = hlClass(m.manager, section);
          // Suffix with the section so PP1 and PP2 rows for the same manager get distinct
          // element IDs — without it, both periods' detail rows shared one ID and toggling
          // either row always found/filled the first (PP1) one in the DOM.
          const mgrKey = m.manager.replace(/[^a-zA-Z0-9]/g, '_') + '_' + section;
          html += `<tr class="sb-manager-row" onclick="toggleManagerDetails('${mgrKey}','${jsStr(m.manager)}','${section}')">
          <td class="rank">${i + 1}</td>
          <td><strong class="${cls}">${esc(m.manager)}</strong>${m.manager === overallLastMgr ? ' <span class="last-place-icon" title="Last place">🗑️💦</span>' : ''} <span class="sb-expand-arrow" id="sb-arrow-${mgrKey}">&#9660;</span></td>
          <td class="num">${fmt(m.batting)}</td>
          <td class="num">${fmt(m.pitching)}</td>
          <td class="num"><strong>${fmt(m.total)}</strong></td>
        </tr>
        <tr class="sb-manager-detail-row" id="mgr-detail-${mgrKey}" data-manager="${esc(m.manager)}" data-sb-period="${section}" data-sb-pool="${safePoolId}" style="display:none;">
          <td colspan="5"><div class="mgr-detail-loading">Loading...</div></td>
        </tr>`;
        });
        html += '</tbody></table></div>';
      });
    html += '</div>';
    return html;
  }

  // Render a single combined table (not grouped by pool)
  function renderOverallTable(scores) {
    if (scores.length === 0) return '<p>No pool play data yet.</p>';
    // Look up pool for each manager
    const mgrPool = {};
    managers.forEach((m) => {
      if (m.pool) mgrPool[m.name] = m.pool;
    });
    let tbl = `<table class="data-table compact-table">
      <thead><tr><th>#</th><th>Manager</th><th>Pool</th><th>B</th><th>P</th><th>Total</th>${odds ? '<th>Playoff&nbsp;%</th>' : ''}</tr></thead><tbody>`;
    scores.forEach((m, i) => {
      const cls = hlClass(m.manager, 'overall');
      const mgrKey = m.manager.replace(/[^a-zA-Z0-9]/g, '_') + '_ov';
      tbl += `<tr class="sb-manager-row" onclick="toggleManagerDetails('${mgrKey}','${jsStr(m.manager)}','overall')">
        <td class="rank">${i + 1}</td>
        <td><strong class="${cls}">${esc(m.manager)}</strong>${m.manager === overallLastMgr ? ' <span class="last-place-icon" title="Last place">🗑️💦</span>' : ''} <span class="sb-expand-arrow" id="sb-arrow-${mgrKey}">&#9660;</span></td>
        <td>${mgrPool[m.manager] || ''}</td>
        <td class="num">${fmt(m.batting)}</td>
        <td class="num">${fmt(m.pitching)}</td>
        <td class="num sb-mob-total"><strong>${fmt(m.total)}</strong></td>
        ${odds ? `<td class="num sb-mob-odds">${oddsPill(m.manager)}</td>` : ''}
      </tr>
      <tr class="sb-manager-detail-row" id="mgr-detail-${mgrKey}" data-manager="${esc(m.manager)}" data-sb-period="overall" style="display:none;">
        <td colspan="${odds ? 7 : 6}"><div class="mgr-detail-loading">Loading...</div></td>
      </tr>`;
    });
    tbl += '</tbody></table>';
    return tbl;
  }

  // ---- Build full HTML ----
  // Pool play starts collapsed (summary visible, tables hidden) once playoff data
  // exists OR pool play is finalized — the latter covers the between-periods break
  // when the bracket is set but no playoff stats have been recorded yet. The
  // showActiveSeason post-render fixup enforces the same state after bracket render.
  const rounds = new Set([...batting.map((b) => b.round), ...pitching.map((p) => p.round)]);
  const hasPlayoffData = rounds.has('QF') || rounds.has('SF') || rounds.has('Finals');
  // A closed season opens nothing on this card: the Playoff Bracket above already leads with
  // the Finals, and `currentSectionId` goes null once the schedule runs out, which would
  // otherwise fall through to "no current period, so open Pool Play 1" and put a ten-week-old
  // table at the top of the page on the day the season ended.
  const seasonClosed = !!(seasonData.season_closed && seasonData.season_closed.at);
  const ppCollapsed = seasonClosed || hasPlayoffData || (seasonData.finalized_rounds || []).includes('PP');

  // Pool-play leaders, precomputed so both the leader cards (inside the body) and the
  // collapsed-state summary (below) can use them.
  const ppHasScores = overallScores.length > 0 && overallScores[0].total > 0;
  const ppTop = ppHasScores ? [...overallScores].sort((a, b) => b.total - a.total)[0] : null;
  const ppBestBat = ppHasScores ? [...overallScores].sort((a, b) => b.batting - a.batting)[0] : null;
  const ppBestPit = ppHasScores ? [...overallScores].sort((a, b) => b.pitching - a.pitching)[0] : null;

  // Minimal snapshot shown only when the Pool Play Scoreboard is collapsed (manually or
  // auto-collapsed once playoffs start). Keeps the key pool-play outcomes — winners, wild
  // cards, high scorers — visible while the Playoff Bracket stays the focus.
  let ppSummaryInner = '';
  if (allPPWinners.size > 0 || wildcardSet.size > 0) {
    ppSummaryInner += `<div class="pp-summary-qual">
      <div class="pp-summary-item"><span class="pp-summary-label">Pool Winners</span><span class="pp-summary-val">${esc([...allPPWinners].sort().join(', ')) || 'TBD'}</span></div>
      <div class="pp-summary-item"><span class="pp-summary-label">Wild Cards</span><span class="pp-summary-val">${esc([...wildcardSet].sort().join(', ')) || 'TBD'}</span></div>
    </div>`;
  }
  if (ppHasScores) {
    const ppSummaryLeaders = [
      { label: 'Top Scorer', mgr: ppTop.manager, val: fmt(ppTop.total) },
      { label: 'Best Batting', mgr: ppBestBat.manager, val: fmt(ppBestBat.batting) },
      { label: 'Best Pitching', mgr: ppBestPit.manager, val: fmt(ppBestPit.pitching) },
    ];
    ppSummaryInner += `<div class="pp-summary-leaders">${ppSummaryLeaders
      .map(
        (s) =>
          `<div class="pp-summary-stat"><span class="pp-summary-label">${s.label}</span><span class="pp-summary-val">${esc(s.mgr)} · ${s.val}</span></div>`
      )
      .join('')}</div>`;
  }
  // Explicit expand affordance — the header's small arrow is easy to miss, so the
  // collapsed summary ends with a labeled button. It lives inside the summary div,
  // which togglePoolPlay hides on expand, so it never shows alongside the tables.
  if (ppSummaryInner) {
    ppSummaryInner += `<button type="button" class="sb-poolplay-expand-btn" onclick="togglePoolPlay()">View Full Pool Play Scoreboard &#9662;</button>`;
  }

  let html = '';

  html += `<div class="card scoreboard-card sb-poolplay-section">
    <div class="sb-poolplay-header${ppCollapsed ? ' sb-poolplay-collapsed' : ''}" onclick="togglePoolPlay()">
      <h2 style="margin:0;border:none;padding:0;">Pool Play Scoreboard</h2>
      <span class="sb-section-arrow">▾</span>
    </div>
    ${ppSummaryInner ? `<div class="sb-poolplay-summary" id="sb-poolplay-summary" style="display:${ppCollapsed ? 'flex' : 'none'};">${ppSummaryInner}</div>` : ''}
    <div class="sb-poolplay-body" id="sb-poolplay-body" style="display:${ppCollapsed ? 'none' : 'block'};">`;

  html += `<div class="highlight-legend sb-color-legend">
    <span class="legend-label">Name Colors:</span>
    <span class="legend-item"><span class="legend-swatch hl-pp1"></span> PP1 Pool Leader</span>
    <span class="legend-item"><span class="legend-swatch hl-pp2"></span> PP2 Pool Leader</span>
    <span class="legend-item"><span class="legend-swatch hl-both"></span> PP1 &amp; PP2 Leader</span>
    <span class="legend-item"><span class="legend-swatch hl-wildcard"></span> Wild Card</span>
  </div>`;

  // Pool Play Overall (combined PP1 + PP2, single list sorted by total)
  html += `<div class="scoreboard-section">
    <h3>Pool Play Overall</h3>
    ${renderOverallTable(overallScores)}
  </div>`;

  // Playoff odds detail panel (only while the PP2 Week 4–5 window is live)
  if (odds) {
    const history = Array.isArray(odds.history) ? odds.history : [];
    const prior = [...history].reverse().find((h) => h.date < odds.date);
    const rows = Object.entries(odds.managers)
      .map(([name, o]) => ({ name, ...o }))
      .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
    const trendHtml = (r) => {
      if (r.locked || !prior || !prior.pcts || prior.pcts[r.name] == null) return '';
      const delta = Math.round(r.pct - prior.pcts[r.name]);
      if (delta >= 1) {
        return ` <span class="odds-trend odds-trend-up" title="vs. ${esc(prior.date)}">&#9650;${delta}</span>`;
      }
      if (delta <= -1) {
        return ` <span class="odds-trend odds-trend-down" title="vs. ${esc(prior.date)}">&#9660;${Math.abs(delta)}</span>`;
      }
      return '';
    };
    // Server stores gaps as points BEHIND (positive = trailing). Render as a
    // signed margin instead: "+50" = 50 ahead, "-120" = 120 back.
    const gapCell = (v) => {
      if (v == null) return '—';
      if (v === 0) return '0';
      return v > 0 ? `-${fmt(v)}` : `+${fmt(-v)}`;
    };
    // schedule_factor is centered at 1.0 (neutral) — display as a signed %
    // so "tougher/easier than average slate" reads at a glance.
    const scheduleFactorCell = (f) => {
      if (f == null) return '—';
      const pct = Math.round((f - 1) * 100);
      if (pct === 0) return 'even';
      return pct > 0 ? `+${pct}%` : `${pct}%`;
    };
    html += `<div class="scoreboard-section">
      <h3>&#128302; Playoff Odds</h3>
      <div class="table-wrapper"><table class="data-table compact-table odds-table">
        <thead><tr>
          <th>Manager</th>
          <th><span class="th-full">Playoff&nbsp;%</span><span class="th-mob">Odds</span></th>
          <th><span class="th-full">Win PP2 Pool</span><span class="th-mob">Pool&nbsp;W</span></th>
          <th><span class="th-full">Wild Card</span><span class="th-mob">WC</span></th>
          <th title="Points behind the current PP2 leader of your pool (+ = you lead)"><span class="th-full">Pool Gap</span><span class="th-mob">P&nbsp;Gap</span></th>
          <th title="Combined-total points vs. the current last qualifier (+ = above the cut)"><span class="th-full">Cut Gap</span><span class="th-mob">C&nbsp;Gap</span></th>
          <th title="Projected points from your roster over the remaining games, including opponent strength, home/away, and park factors"><span class="th-full">Proj. Left</span><span class="th-mob">Proj</span></th>
          <th title="MLB games remaining for your rostered players"><span class="th-full">Games Left</span><span class="th-mob">G</span></th>
          <th title="Average per-game adjustment across your roster's remaining schedule (opponent quality + home/away + park), relative to a neutral slate"><span class="th-full">Sched.</span><span class="th-mob">Sch</span></th>
        </tr></thead><tbody>
        ${rows
          .map(
            (r) => `<tr>
          <td><strong class="${hlClass(r.name, 'overall')}">${esc(r.name)}</strong></td>
          <td class="num">${oddsPill(r.name)}${trendHtml(r)}</td>
          <td class="num">${r.locked ? '—' : formatOddsPct(r.pool_win_pct / 100)}</td>
          <td class="num">${r.locked ? '—' : formatOddsPct(r.wildcard_pct / 100)}</td>
          <td class="num">${gapCell(r.points_back_pool)}</td>
          <td class="num">${gapCell(r.points_back_cut)}</td>
          <td class="num">${fmt(r.proj_mean)}</td>
          <td class="num">${r.games_remaining}</td>
          <td class="num">${scheduleFactorCell(r.schedule_factor)}</td>
        </tr>`
          )
          .join('')}
        </tbody></table></div>
      <p class="odds-note">Likelihood of reaching the 8-team playoff, from ${Number(odds.sims).toLocaleString('en-US')} simulations
      of the remaining schedule (each rostered player's per-game scoring rate, adjusted for opponent pitching/hitting
      quality, home/away, and park factors, &times; their team's remaining MLB games, re-run against the pool-winner
      and wild-card rules). &#128274; = clinched via PP1 pool win. Updated ${esc(odds.date)} — recomputed each morning.</p>
    </div>`;
  }

  // Pool Play leader stat cards (pool play scores only)
  if (ppHasScores) {
    const ppLeaderCards = [
      { label: 'Pool Play Leader', value: fmt(ppTop.total), detail: ppTop.manager },
      { label: 'Best Batting', value: fmt(ppBestBat.batting), detail: ppBestBat.manager },
      { label: 'Best Pitching', value: fmt(ppBestPit.pitching), detail: ppBestPit.manager },
    ];
    html += `<div class="stats-grid pp-leader-cards">${ppLeaderCards
      .map(
        (s) => `
      <div class="stat-card">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value">${s.value}</div>
        <div class="stat-detail">${s.detail}</div>
      </div>`
      )
      .join('')}</div>`;
  }

  // Pool Play 1
  const pp1Open = !seasonClosed && (!currentSectionId || currentSectionId === 'pp1');
  html += `
    <div class="sb-section${pp1Open ? '' : ' sb-section-collapsed'}" id="sb-section-pp1">
      <div class="sb-section-header" onclick="toggleScoreboardSection('pp1')">
        <span class="sb-section-title">Pool Play 1</span>
        <span class="sb-section-arrow">▾</span>
      </div>
      <div id="sb-pp1" style="display:${pp1Open ? 'block' : 'none'}">
        ${renderPoolSection(pp1Scores, 'Pool Play 1', 'pp1')}
      </div>
    </div>`;

  // Pool Play 2
  const pp2Open = !seasonClosed && currentSectionId === 'pp2';
  html += `
    <div class="sb-section${pp2Open ? '' : ' sb-section-collapsed'}" id="sb-section-pp2">
      <div class="sb-section-header" onclick="toggleScoreboardSection('pp2')">
        <span class="sb-section-title">Pool Play 2</span>
        <span class="sb-section-arrow">▾</span>
      </div>
      <div id="sb-pp2" style="display:${pp2Open ? 'block' : 'none'}">
        ${renderPoolSection(pp2Scores, 'Pool Play 2', 'pp2')}
      </div>
    </div>`;

  // Playoff Advancement summary
  if (allPPWinners.size > 0 || wildcardSet.size > 0) {
    html += `<div class="scoreboard-section">
      <h3>Playoff Advancement</h3>
      <div class="advancement-summary">
        <p><strong>Pool Play Winners (${allPPWinners.size}):</strong> ${[...allPPWinners].sort().join(', ') || 'TBD'}</p>
        <p><strong>Wild Cards (${wildcardSet.size} spot${wildcardSet.size !== 1 ? 's' : ''}):</strong> ${[...wildcardSet].sort().join(', ') || 'TBD'}</p>
        <p><strong>Total Playoff Qualifiers:</strong> ${allPPWinners.size + wildcardSet.size} of 8</p>
      </div>
      <div class="highlight-legend">
        <span class="legend-item"><span class="legend-swatch hl-pp1">&nbsp;&nbsp;</span> PP1 Winner</span>
        <span class="legend-item"><span class="legend-swatch hl-pp2">&nbsp;&nbsp;</span> PP2 Winner</span>
        <span class="legend-item"><span class="legend-swatch hl-both">&nbsp;&nbsp;</span> Both Periods</span>
        <span class="legend-item"><span class="legend-swatch hl-wildcard">&nbsp;&nbsp;</span> Wild Card</span>
      </div>
    </div>`;
  }
  html += `</div></div>`; // close sb-poolplay-body and sb-poolplay-section

  // No QF/SF/Finals sections here on purpose. The Playoff Bracket card (buildActivePlayoffBracket,
  // rendered into #scoreboard-bracket and moved ABOVE this content once pool play is finalized)
  // already shows every round's pairings, totals and B/P split — and unlike a second copy down
  // here, its rows expand into the per-player breakdown. Two views of the same eight matchups on
  // one page was just noise.

  return html;
}

function renderActiveWeekly(seasonData) {
  renderSeasonAccolades();
  const teamWeekly = buildTeamWeekly(seasonData);
  if (teamWeekly.length === 0) {
    document.getElementById('weekly-table').innerHTML = '<tbody><tr><td>No weekly data yet.</td></tr></tbody>';
    return;
  }

  const origData = DATA;
  DATA = { team_weekly: teamWeekly };
  renderWeekly();
  DATA = origData;
}

function renderActivePlayers(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  if (batting.length === 0 && pitching.length === 0) {
    document.getElementById('players-table').innerHTML = '<tbody><tr><td>No player data yet.</td></tr></tbody>';
    return;
  }

  // Use stored manager field (banked at upload/assign time); show (Unassigned) for null
  const fixedBatting = batting.map((b) => ({ ...b, manager: b.manager || '(Unassigned)' }));
  const fixedPitching = pitching.map((p) => ({ ...p, manager: p.manager || '(Unassigned)' }));

  const origData = DATA;
  DATA = { batting_weekly: fixedBatting, pitching_weekly: fixedPitching };
  renderPlayers();
  DATA = origData;
}

// ============================================================
// Trends / Analytics
// ============================================================
const _trendsCharts = {};

function destroyTrendsCharts() {
  Object.values(_trendsCharts).forEach((c) => {
    try {
      c.destroy();
    } catch {
      /* chart already gone */
    }
  });
  Object.keys(_trendsCharts).forEach((k) => delete _trendsCharts[k]);
}

const CHART_COLORS = [
  '#1a3a5c',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#ec4899',
  '#84cc16',
  '#6366f1',
  '#14b8a6',
  '#e11d48',
  '#fb923c',
  '#a78bfa',
  '#34d399',
];

// ============================================================
// Season Accolades — season-long daily best/worst tallies shown at the top of
// the Season Stats tab. Pure math lives in js/accolades.js (computeSeasonAccolades,
// unit-tested); this renders it from the on-demand daily stats cache.
// ============================================================
function renderSeasonAccolades() {
  const container = document.getElementById('season-accolades-content');
  if (!container) return;
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  if (!seasonData) {
    container.innerHTML = '';
    return;
  }

  const heading = `<h2>Season Accolades</h2>
      <p class="upload-hint">Best of the best, worst of the worst — daily finishes tracked across the whole season, counting only players while they were rostered.</p>`;

  const dailyStats = getDailyStatsCached(SELECTED_SEASON);
  ensureDailyStats(SELECTED_SEASON, renderSeasonAccolades);
  if (!dailyStats || (dailyStats.batting.length === 0 && dailyStats.pitching.length === 0)) {
    container.innerHTML = `<div class="card">${heading}<p>${dailyStats ? 'No daily stat data recorded for this season.' : 'Loading daily stat data…'}</p></div>`;
    return;
  }

  const managers = getManagers();
  const registeredNames = new Set(managers.map((m) => m.name));
  const rosterLookup = buildRosterLookup(seasonData);
  const resolveManager = (row, type) => {
    const name = type === 'batting' ? row.batter : row.pitcher;
    const mgr = row.manager || rosterLookup[rosterLookupKey(name, row.round, row.week)];
    return mgr && registeredNames.has(mgr) ? mgr : null;
  };

  const acc = computeSeasonAccolades({
    dailyBatting: dailyStats.batting,
    dailyPitching: dailyStats.pitching,
    resolveManager,
  });

  if (acc.days === 0) {
    container.innerHTML = `<div class="card">${heading}<p>No game days with rostered-player stats yet.</p></div>`;
    return;
  }

  const TOP_N = 5;
  const fmtDay = (d) => {
    const [, m, day] = String(d).split('-');
    return `${parseInt(m)}/${parseInt(day)}`;
  };
  const emptyNote = '<p class="accolade-empty">Nothing yet — check back after more games.</p>';

  // ---- Full scoring stat lines (every category that feeds the score) ----
  const BAT_COLS = [
    ['abs', 'AB'],
    ['1b', '1B'],
    ['2b', '2B'],
    ['3b', '3B'],
    ['hr', 'HR'],
    ['r', 'R'],
    ['rbi', 'RBI'],
    ['sb', 'SB'],
    ['bb', 'BB'],
    ['so', 'K'],
  ];
  const PIT_COLS = [
    ['ip', 'IP'],
    ['h', 'H'],
    ['er', 'ER'],
    ['bb', 'BB'],
    ['k', 'K'],
    ['w', 'W'],
    ['qs', 'QS'],
    ['cg', 'CG'],
    ['cgso', 'CGSO'],
    ['nh', 'NH'],
  ];
  const statHeaderCells = (cols) => cols.map(([, label]) => `<th>${label}</th>`).join('');
  const statValueCells = (cols, stats) =>
    cols.map(([k]) => `<td>${k === 'ip' ? fmtDec(stats[k] || 0) : fmt(stats[k] || 0)}</td>`).join('');

  // The detail tables must fit their box without side-scrolling, so columns
  // that are zero for every shown row are dropped — except the core categories
  // that should always read as part of the line (a 0-for-4 still shows AB/1B/…).
  const BAT_CORE = new Set(['abs', '1b', '2b', 'hr', 'r', 'rbi', 'bb', 'so']);
  const PIT_CORE = new Set(['ip', 'h', 'er', 'bb', 'k']);
  const visibleCols = (cols, core, statRows) =>
    cols.filter(([k]) => core.has(k) || statRows.some((s) => (parseFloat(s[k]) || 0) !== 0));

  // Full stat line for one player-day (used in the player-day expansions) —
  // just the scoring columns; the player's name is already on the row above.
  const playerStatTable = (p) => {
    const isPit = p.type === 'Pitcher';
    const cols = visibleCols(isPit ? PIT_COLS : BAT_COLS, isPit ? PIT_CORE : BAT_CORE, [p.stats || {}]);
    return `<table class="data-table compact-table accolade-detail-table"><thead><tr>${statHeaderCells(cols)}<th>Pts</th></tr></thead><tbody>
        <tr>${statValueCells(cols, p.stats || {})}<td><strong>${fmt(p.score)}</strong></td></tr>
      </tbody></table>`;
  };

  // Full stat breakdown for a manager-day (batters and pitchers each get a
  // table with their own scoring columns), best score first within each group.
  const managerDayDetail = (players) => {
    const group = (type, allCols, core) => {
      const subset = (players || []).filter((p) => p.type === type);
      if (!subset.length) return '';
      const cols = visibleCols(
        allCols,
        core,
        subset.map((p) => p.stats || {})
      );
      return `<table class="data-table compact-table accolade-detail-table accolade-detail-named"><thead><tr><th>${type}s</th>${statHeaderCells(cols)}<th>Pts</th></tr></thead><tbody>
          ${subset
            .map(
              (p) =>
                `<tr><td>${displayPlayer(p.player, seasonData)}</td>${statValueCells(cols, p.stats || {})}<td><strong>${fmt(p.score)}</strong></td></tr>`
            )
            .join('')}
        </tbody></table>`;
    };
    return (
      group('Batter', BAT_COLS, BAT_CORE) + group('Pitcher', PIT_COLS, PIT_CORE) ||
      '<p>No player detail for this day.</p>'
    );
  };

  const managerDayList = (rows, keyPrefix) =>
    rows.length
      ? `<div class="table-wrapper"><table class="data-table compact-table"><thead><tr><th>Manager</th><th>Pts</th><th>Date</th></tr></thead><tbody>
          ${rows
            .map((r, i) => {
              const did = `acc-rec-${keyPrefix}-${i}`;
              return `<tr class="accolade-row-click" onclick="toggleAccoladeDetail('${did}')" title="Show the day's player breakdown"><td><strong>${esc(r.manager)}</strong> <span class="accolade-caret">&#9662;</span></td><td>${fmt(r.total)}</td><td>${fmtDay(r.date)}</td></tr>
              <tr id="${did}" class="accolade-detail-row" style="display:none"><td colspan="3">${managerDayDetail(r.players)}</td></tr>`;
            })
            .join('')}
        </tbody></table></div>`
      : emptyNote;

  const playerDayList = (rows, showK, keyPrefix) =>
    rows.length
      ? `<div class="table-wrapper"><table class="data-table compact-table"><thead><tr><th>Player</th><th>Manager</th><th>Pts</th><th>Date</th></tr></thead><tbody>
          ${rows
            .map((r, i) => {
              const did = `acc-rec-${keyPrefix}-${i}`;
              return `<tr class="accolade-row-click" onclick="toggleAccoladeDetail('${did}')" title="Show the day's full stat line"><td>${displayPlayer(r.player, seasonData)}${showK && r.so >= 3 ? ` · ${r.so} K` : ''} <span class="accolade-caret">&#9662;</span></td><td>${esc(r.manager)}</td><td>${fmt(r.score)}</td><td>${fmtDay(r.date)}</td></tr>
              <tr id="${did}" class="accolade-detail-row" style="display:none"><td colspan="4">${playerStatTable(r)}</td></tr>`;
            })
            .join('')}
        </tbody></table></div>`
      : emptyNote;

  const managerTable = (rows, countHeader) =>
    rows.length
      ? `<div class="table-wrapper"><table class="data-table compact-table"><thead><tr><th>Manager</th><th>${countHeader}</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td><strong>${esc(r.manager)}</strong></td><td>${r.count}</td></tr>`).join('')}
        </tbody></table></div>`
      : emptyNote;

  // Worst-5 player tallies, mirroring the record lists. Anyone past 5th place
  // who is tied with the 5th-place count collapses into one summary line.
  const topWithTies = (rows, tieLine) => {
    const shown = rows.slice(0, TOP_N);
    let note = '';
    if (rows.length > TOP_N) {
      const cutoff = rows[TOP_N - 1].count;
      const tied = rows.slice(TOP_N).filter((r) => r.count === cutoff);
      if (tied.length) note = `<p class="accolade-tie-note">${tieLine(tied.length, cutoff)}</p>`;
    }
    return { shown, note };
  };

  const pitcherTally = topWithTies(
    acc.pitcherNegativeDays,
    (n, days) => `${n} more pitcher${n === 1 ? '' : 's'} tied with ${days} day${days === 1 ? '' : 's'} &lt; 0`
  );
  const pitcherTable = pitcherTally.shown.length
    ? `<div class="table-wrapper"><table class="data-table compact-table"><thead><tr><th>Pitcher</th><th>Manager</th><th>Days &lt; 0</th><th>Worst Day</th></tr></thead><tbody>
        ${pitcherTally.shown
          .map(
            (r) =>
              `<tr><td>${displayPlayer(r.player, seasonData)}</td><td>${esc(r.manager)}</td><td>${r.count}</td><td>${fmt(r.worst.score)} (${fmtDay(r.worst.date)})</td></tr>`
          )
          .join('')}
      </tbody></table></div>${pitcherTally.note}`
    : emptyNote;

  // The box is titled "Sombrero Watch", so the tier labels stay short:
  // 4 K = golden sombrero, 5+ K = platinum sombrero.
  const sombrero = (k) => (k >= 5 ? ' · platinum!' : k >= 4 ? ' · golden' : '');
  const batterTally = topWithTies(
    acc.batterHighKDays,
    (n, days) => `${n} more batter${n === 1 ? '' : 's'} tied with ${days} day${days === 1 ? '' : 's'} of 3+ K`
  );
  const batterTable = batterTally.shown.length
    ? `<div class="table-wrapper"><table class="data-table compact-table"><thead><tr><th>Batter</th><th>Manager</th><th>3+ K Days</th><th>Worst Day</th></tr></thead><tbody>
        ${batterTally.shown
          .map(
            (r) =>
              `<tr><td>${displayPlayer(r.player, seasonData)}</td><td>${esc(r.manager)}</td><td>${r.count}</td><td>${r.maxK} K (${fmtDay(r.worst.date)})${sombrero(r.maxK)}</td></tr>`
          )
          .join('')}
      </tbody></table></div>${batterTally.note}`
    : emptyNote;

  const rec = acc.records;
  container.innerHTML = `
    <div class="card">
      ${heading}

      <div class="accolade-section">
        <h3 class="accolade-section-title">Manager Single-Day Records</h3>
        <p class="accolade-sub">The five best and worst single-day manager totals — click a row for the day's player breakdown</p>
        <div class="accolade-pair">
          <div class="accolade-box"><h4>&#128197; Best Manager Days</h4>${managerDayList(rec.bestManagerDays, 'bmd')}</div>
          <div class="accolade-box"><h4>&#128198; Worst Manager Days</h4>${managerDayList(rec.worstManagerDays, 'wmd')}</div>
        </div>
      </div>

      <div class="accolade-section">
        <h3 class="accolade-section-title">Manager Season Records</h3>
        <p class="accolade-sub">Daily finishes tallied across ${acc.days} game day${acc.days === 1 ? '' : 's'}</p>
        <div class="accolade-pair">
          <div class="accolade-box">
            <h4>&#127942; Best of the Best</h4>
            <p class="accolade-sub">Days finished in the daily top 3</p>
            ${managerTable(acc.managerBest, 'Top-3 Days')}
          </div>
          <div class="accolade-box">
            <h4>&#129398; Worst of the Worst</h4>
            <p class="accolade-sub">Days finished in the daily bottom 3</p>
            ${managerTable(acc.managerWorst, 'Bottom-3 Days')}
          </div>
        </div>
      </div>

      <div class="accolade-section">
        <h3 class="accolade-section-title">Player Single-Day Records</h3>
        <p class="accolade-sub">The five best and worst single-day player scores — click a row for the full stat line</p>
        <div class="accolade-pair">
          <div class="accolade-box"><h4>&#11088; Best Player Days</h4>${playerDayList(rec.bestPlayerDays, false, 'bpd')}</div>
          <div class="accolade-box"><h4>&#128128; Worst Player Days</h4>${playerDayList(rec.worstPlayerDays, true, 'wpd')}</div>
        </div>
      </div>

      <div class="accolade-section">
        <h3 class="accolade-section-title">Player Season Records</h3>
        <p class="accolade-sub">The five worst repeat offenders of the season</p>
        <div class="accolade-pair">
          <div class="accolade-box">
            <h4>&#128201; Rough Outings</h4>
            <p class="accolade-sub">Pitchers with negative-point days</p>
            ${pitcherTable}
          </div>
          <div class="accolade-box">
            <h4>&#127913; Sombrero Watch</h4>
            <p class="accolade-sub">Batters with 3+ strikeout days</p>
            ${batterTable}
          </div>
        </div>
      </div>
    </div>`;
}

// Smooth-scroll to a Season Stats section (jump-nav row in index.html).
window.scrollToSection = function (id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Expand/collapse a Single-Day Records detail row (inline onclick handler).
window.toggleAccoladeDetail = function (id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
};

function renderTrends() {
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  const container = document.getElementById('trends-content');
  if (!seasonData || !container) return;

  destroyTrendsCharts();

  // ---- Gather unified data ----
  let teamWeekly, battingData, pitchingData;

  if (seasonData.status === 'completed' && seasonData.data) {
    teamWeekly = seasonData.data.team_weekly || [];
    battingData = (seasonData.data.batting_weekly || []).map((b) => ({
      player: b.batter,
      manager: b.manager,
      round: b.round,
      week: b.week,
      weekly_score: b.weekly_score || 0,
    }));
    pitchingData = (seasonData.data.pitching_weekly || []).map((p) => ({
      player: p.pitcher,
      manager: p.manager,
      round: p.round,
      week: p.week,
      weekly_score: p.weekly_score || 0,
    }));
  } else {
    teamWeekly = buildTeamWeekly(seasonData);
    const trendsRosterLookup = buildRosterLookup(seasonData);
    battingData = (seasonData.weekly_batting || [])
      .map((b) => {
        const mgr = b.manager || trendsRosterLookup[rosterLookupKey(b.batter, b.round, b.week)];
        return mgr
          ? { player: b.batter, manager: mgr, round: b.round, week: b.week, weekly_score: b.weekly_score || 0 }
          : null;
      })
      .filter(Boolean);
    pitchingData = (seasonData.weekly_pitching || [])
      .map((p) => {
        const mgr = p.manager || trendsRosterLookup[rosterLookupKey(p.pitcher, p.round, p.week)];
        return mgr
          ? { player: p.pitcher, manager: mgr, round: p.round, week: p.week, weekly_score: p.weekly_score || 0 }
          : null;
      })
      .filter(Boolean);
  }

  // ---- Pool groups & registered manager names ----
  const managers = getManagers();
  const registeredNames = new Set(managers.map((m) => m.name));
  const poolGroups = {};
  managers.forEach((m) => {
    if (m.pool && m.active !== false) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });
  const poolNums = Object.keys(poolGroups).sort();
  const hasPools = poolNums.length > 0;
  const mgrPoolMap = {};
  managers.forEach((m) => {
    if (m.pool) mgrPoolMap[m.name] = m.pool;
  });

  // ---- Filter data to registered managers only ----
  teamWeekly = teamWeekly.filter((t) => registeredNames.has(t.manager));
  battingData = battingData.filter((b) => registeredNames.has(b.manager));
  pitchingData = pitchingData.filter((p) => registeredNames.has(p.manager));

  if (teamWeekly.length === 0 && battingData.length === 0 && pitchingData.length === 0) {
    container.innerHTML =
      '<div class="card"><p>No scoring data available yet. Upload weekly stats via the Commissioner page.</p></div>';
    return;
  }

  // ---- Daily data (for daily manager view) ----
  // Daily rows are fetched on demand (no longer part of the seasons payload). First visit
  // renders the weekly charts immediately and re-renders once the daily data lands.
  const dailyStats = getDailyStatsCached(SELECTED_SEASON);
  ensureDailyStats(SELECTED_SEASON, renderTrends);
  const dailyBattingRows = (dailyStats && dailyStats.batting) || [];
  const dailyPitchingRows = (dailyStats && dailyStats.pitching) || [];
  const dailyRosterLookup = buildRosterLookup(seasonData);
  const dailyManagerScores = {};
  dailyBattingRows.forEach((rec) => {
    const mgr = rec.manager || dailyRosterLookup[rosterLookupKey(rec.batter, rec.round, rec.week)];
    if (!mgr || !registeredNames.has(mgr)) return;
    const score = calculateBattingScore(rec.delta || {});
    if (!dailyManagerScores[rec.date]) dailyManagerScores[rec.date] = {};
    dailyManagerScores[rec.date][mgr] = (dailyManagerScores[rec.date][mgr] || 0) + score;
  });
  dailyPitchingRows.forEach((rec) => {
    const mgr = rec.manager || dailyRosterLookup[rosterLookupKey(rec.pitcher, rec.round, rec.week)];
    if (!mgr || !registeredNames.has(mgr)) return;
    const score = calculatePitchingScore(rec.delta || {});
    if (!dailyManagerScores[rec.date]) dailyManagerScores[rec.date] = {};
    dailyManagerScores[rec.date][mgr] = (dailyManagerScores[rec.date][mgr] || 0) + score;
  });

  const dailyPlayerBattingScores = {};
  dailyBattingRows.forEach((rec) => {
    const score = calculateBattingScore(rec.delta || {});
    if (!dailyPlayerBattingScores[rec.date]) dailyPlayerBattingScores[rec.date] = {};
    dailyPlayerBattingScores[rec.date][rec.batter] = (dailyPlayerBattingScores[rec.date][rec.batter] || 0) + score;
  });
  const dailyPlayerPitchingScores = {};
  dailyPitchingRows.forEach((rec) => {
    const score = calculatePitchingScore(rec.delta || {});
    if (!dailyPlayerPitchingScores[rec.date]) dailyPlayerPitchingScores[rec.date] = {};
    dailyPlayerPitchingScores[rec.date][rec.pitcher] = (dailyPlayerPitchingScores[rec.date][rec.pitcher] || 0) + score;
  });

  const orderedDates = Object.keys(dailyManagerScores).sort();
  const orderedBatterDates = Object.keys(dailyPlayerBattingScores).sort();
  const orderedPitcherDates = Object.keys(dailyPlayerPitchingScores).sort();

  const makeDailyLabels = (dates) =>
    dates.map((d) => {
      const [, m, day] = d.split('-');
      return `${parseInt(m)}/${parseInt(day)}`;
    });
  const dailyChartLabels = makeDailyLabels(orderedDates);
  const batterDailyLabels = makeDailyLabels(orderedBatterDates);
  const pitcherDailyLabels = makeDailyLabels(orderedPitcherDates);
  const hasDailyData = orderedDates.length > 0 || orderedBatterDates.length > 0 || orderedPitcherDates.length > 0;

  // ---- Ordered weeks (chronological via SEASON_SCHEDULE) ----
  const allWeekKeys = new Set([
    ...teamWeekly.map((t) => `${t.round}|${t.week}`),
    ...battingData.map((b) => `${b.round}|${b.week}`),
    ...pitchingData.map((p) => `${p.round}|${p.week}`),
  ]);

  const scheduleOrdered = SEASON_SCHEDULE.map((s) => ({
    key: `${s.round}|${s.week}`,
    round: s.round,
    week: s.week,
  })).filter((s) => allWeekKeys.has(s.key));

  const unknownKeys = [...allWeekKeys].filter((k) => !scheduleOrdered.find((s) => s.key === k));
  unknownKeys.forEach((k) => {
    const [round, week] = k.split('|');
    scheduleOrdered.push({ key: k, round, week });
  });

  const orderedWeeks = scheduleOrdered;
  const rShort = { PP1: 'PP1', PP1P: 'PP1+', PP2: 'PP2', PP2P: 'PP2+', QF: 'QF', SF: 'SF', Finals: 'Fnls' };
  const dates = getScheduleDates();
  const chartLabels = orderedWeeks.map((w) => {
    const base = `${rShort[w.round] || w.round} ${w.week.replace('Week ', 'W')}`;
    if (!dates) return base;
    const wi = weekIndexFromKey(w.round, w.week);
    if (wi < 0 || !dates[wi]) return base;
    return `${base} (${fmtDateRangeShort(dates[wi].start, dates[wi].end)})`;
  });

  // ---- Unique sets (only managers with actual data) ----
  const allManagers = [...registeredNames]
    .filter(
      (name) =>
        teamWeekly.some((t) => t.manager === name) ||
        battingData.some((b) => b.manager === name) ||
        pitchingData.some((p) => p.manager === name)
    )
    .sort();
  const allBatters = [...new Set(battingData.map((b) => b.player))].sort();
  const allPitchers = [...new Set(pitchingData.map((p) => p.player))].sort();

  // ---- State ----
  const selectedManagers = new Set(allManagers);
  let managerMode = hasDailyData ? 'daily' : 'weekly';
  let batterMode = hasDailyData ? 'daily' : 'weekly';
  let pitcherMode = hasDailyData ? 'daily' : 'weekly';
  let showAllOnHover = false;
  let activePanel = 'managers';
  const mgrsForBatters = new Set(allManagers);
  const mgrsForPitchers = new Set(allManagers);
  let selectedBatters = new Set();
  let selectedPitchers = new Set();

  // ---- Pool filter buttons HTML ----
  const poolBtnsHtml = hasPools
    ? `<div class="trends-control-row">
            <span class="trends-label">By Pool</span>
            ${poolNums.map((p) => `<button class="btn btn-sm btn-secondary pool-filter-btn" data-pool="${p}">${formatPool(p)}</button>`).join('')}
          </div>`
    : '';
  const mgrPoolBtnsHtml = (prefix) =>
    hasPools
      ? `<div class="trends-control-row">
            <span class="trends-label">By Pool</span>
            ${poolNums.map((p) => `<button class="btn btn-sm btn-secondary pool-filter-btn" data-pool="${p}" data-prefix="${prefix}">${formatPool(p)}</button>`).join('')}
          </div>`
      : '';

  // ---- Build HTML ----
  container.innerHTML = `
    <div class="card">
      <h2>Trends</h2>
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:1.25rem;">
        <div class="player-type-toggle trends-view-toggle" style="margin-bottom:0;">
          <button class="type-btn active" data-view="managers">Manager Trends</button>
          <button class="type-btn" data-view="batters">Batters</button>
          <button class="type-btn" data-view="pitchers">Pitchers</button>
        </div>
        <div class="player-type-toggle" style="margin-bottom:0;">
          <button class="type-btn active" id="hover-focus-btn">Focus</button>
          <button class="type-btn" id="hover-all-btn">All Sorted</button>
        </div>
      </div>

      <!-- Manager Trends -->
      <div id="trends-managers-panel" class="trends-panel">
        <div class="trends-controls">
          <div class="trends-control-row">
            <span class="trends-label">View Mode</span>
            <div class="player-type-toggle" style="display:inline-flex;">
              ${hasDailyData ? `<button class="type-btn active" id="mode-daily">Daily</button>` : ''}
              <button class="type-btn ${hasDailyData ? '' : 'active'}" id="mode-weekly">Weekly</button>
              <button class="type-btn" id="mode-cumulative">Cumulative</button>
            </div>
          </div>
          ${poolBtnsHtml}
          <div class="trends-control-row">
            <span class="trends-label">Managers</span>
            <button class="btn btn-sm btn-secondary" id="mgr-all-btn">All</button>
            <button class="btn btn-sm btn-secondary" id="mgr-none-btn">None</button>
            <div class="chip-select" id="manager-chips"></div>
          </div>
        </div>
        <div class="chart-wrapper"><canvas id="trends-manager-chart"></canvas></div>
      </div>

      <!-- Batters -->
      <div id="trends-batters-panel" class="trends-panel" style="display:none;">
        <div class="trends-controls">
          <div class="trends-control-row">
            <span class="trends-label">View Mode</span>
            <div class="player-type-toggle" style="display:inline-flex;">
              ${hasDailyData ? `<button class="type-btn active" id="bat-mode-daily">Daily</button>` : ''}
              <button class="type-btn ${hasDailyData ? '' : 'active'}" id="bat-mode-weekly">Weekly</button>
              <button class="type-btn" id="bat-mode-cumulative">Cumulative</button>
            </div>
          </div>
          ${mgrPoolBtnsHtml('bat')}
          <div class="trends-control-row">
            <span class="trends-label">By Manager</span>
            <button class="btn btn-sm btn-secondary" id="bat-mgr-all-btn">All</button>
            <button class="btn btn-sm btn-secondary" id="bat-mgr-none-btn">None</button>
            <div class="chip-select" id="batter-mgr-chips"></div>
          </div>
          <div class="trends-control-row">
            <span class="trends-label">Players</span>
            <button class="btn btn-sm btn-secondary" id="bat-all-btn">All</button>
            <button class="btn btn-sm btn-secondary" id="bat-none-btn">None</button>
            <div class="chip-select" id="batter-chips"></div>
          </div>
        </div>
        <div class="chart-wrapper"><canvas id="trends-batter-chart"></canvas></div>
      </div>

      <!-- Pitchers -->
      <div id="trends-pitchers-panel" class="trends-panel" style="display:none;">
        <div class="trends-controls">
          <div class="trends-control-row">
            <span class="trends-label">View Mode</span>
            <div class="player-type-toggle" style="display:inline-flex;">
              ${hasDailyData ? `<button class="type-btn active" id="pit-mode-daily">Daily</button>` : ''}
              <button class="type-btn ${hasDailyData ? '' : 'active'}" id="pit-mode-weekly">Weekly</button>
              <button class="type-btn" id="pit-mode-cumulative">Cumulative</button>
            </div>
          </div>
          ${mgrPoolBtnsHtml('pit')}
          <div class="trends-control-row">
            <span class="trends-label">By Manager</span>
            <button class="btn btn-sm btn-secondary" id="pit-mgr-all-btn">All</button>
            <button class="btn btn-sm btn-secondary" id="pit-mgr-none-btn">None</button>
            <div class="chip-select" id="pitcher-mgr-chips"></div>
          </div>
          <div class="trends-control-row">
            <span class="trends-label">Players</span>
            <button class="btn btn-sm btn-secondary" id="pit-all-btn">All</button>
            <button class="btn btn-sm btn-secondary" id="pit-none-btn">None</button>
            <div class="chip-select" id="pitcher-chips"></div>
          </div>
        </div>
        <div class="chart-wrapper"><canvas id="trends-pitcher-chart"></canvas></div>
      </div>
    </div>
  `;

  // ---- Chart drawing helpers ----
  function makeChart(canvasId, datasets, yLabel, labels) {
    if (_trendsCharts[canvasId]) {
      try {
        _trendsCharts[canvasId].destroy();
      } catch {
        /* chart already gone */
      }
    }
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return;
    const tooltipOpts = showAllOnHover
      ? {
          itemSort: (a, b) => (b.parsed.y ?? -Infinity) - (a.parsed.y ?? -Infinity),
          filter: (item) => item.parsed.y != null,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
          },
        }
      : {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? fmt(ctx.parsed.y) : '—'}`,
          },
        };
    _trendsCharts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: { labels: labels || chartLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: showAllOnHover ? 'index' : 'nearest', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 10 } },
          tooltip: tooltipOpts,
        },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 30 } },
          y: { title: { display: !!yLabel, text: yLabel }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }

  function buildManagerDatasets() {
    return [...selectedManagers].map((mgr) => {
      const colorIdx = allManagers.indexOf(mgr);
      const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
      const weekly = orderedWeeks.map((w) => {
        const entry = teamWeekly.find((t) => t.manager === mgr && t.round === w.round && t.week === w.week);
        return entry ? entry.weekly_total : null;
      });
      let data = weekly;
      if (managerMode === 'cumulative') {
        let cum = 0;
        data = weekly.map((v) => {
          if (v !== null) cum += v;
          return v !== null ? Math.round(cum * 100) / 100 : null;
        });
      }
      return {
        label: mgr,
        data,
        borderColor: color,
        backgroundColor: color + '28',
        tension: 0.3,
        spanGaps: true,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    });
  }

  function buildDailyManagerDatasets() {
    return [...selectedManagers].map((mgr) => {
      const colorIdx = allManagers.indexOf(mgr);
      const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
      const data = orderedDates.map((date) => {
        const score = dailyManagerScores[date] && dailyManagerScores[date][mgr];
        return score != null ? Math.round(score * 100) / 100 : null;
      });
      return {
        label: mgr,
        data,
        borderColor: color,
        backgroundColor: color + '28',
        tension: 0.3,
        spanGaps: true,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    });
  }

  function buildPlayerDatasets(sourceData, allPlayerList, selectedPlayers, mode, dailyScores, dailyDates) {
    return [...selectedPlayers].map((player) => {
      const colorIdx = allPlayerList.indexOf(player);
      const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
      let data;
      if (mode === 'daily') {
        data = (dailyDates || []).map((date) => {
          const score = dailyScores && dailyScores[date] && dailyScores[date][player];
          return score != null ? Math.round(score * 100) / 100 : null;
        });
      } else {
        const weekly = orderedWeeks.map((w) => {
          const rows = sourceData.filter((d) => d.player === player && d.round === w.round && d.week === w.week);
          return rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.weekly_score, 0) * 100) / 100 : null;
        });
        if (mode === 'cumulative') {
          let cum = 0;
          data = weekly.map((v) => {
            if (v !== null) cum += v;
            return v !== null ? Math.round(cum * 100) / 100 : null;
          });
        } else {
          data = weekly;
        }
      }
      return {
        label: player,
        data,
        borderColor: color,
        backgroundColor: color + '28',
        tension: 0.3,
        spanGaps: true,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    });
  }

  function drawManagerChart() {
    if (managerMode === 'daily') {
      makeChart('trends-manager-chart', buildDailyManagerDatasets(), 'Daily Points', dailyChartLabels);
    } else {
      const label = managerMode === 'cumulative' ? 'Cumulative Points' : 'Weekly Points';
      makeChart('trends-manager-chart', buildManagerDatasets(), label);
    }
  }

  function getVisibleBatters() {
    return [...new Set(battingData.filter((b) => mgrsForBatters.has(b.manager)).map((b) => b.player))].sort();
  }

  function getVisiblePitchers() {
    return [...new Set(pitchingData.filter((p) => mgrsForPitchers.has(p.manager)).map((p) => p.player))].sort();
  }

  function drawBatterChart() {
    const visible = getVisibleBatters();
    const active = new Set([...selectedBatters].filter((p) => visible.includes(p)));
    selectedBatters = active;
    const filtered = battingData.filter((b) => mgrsForBatters.has(b.manager));
    const yLabel =
      batterMode === 'daily' ? 'Daily Points' : batterMode === 'cumulative' ? 'Cumulative Points' : 'Weekly Points';
    const labels = batterMode === 'daily' ? batterDailyLabels : undefined;
    makeChart(
      'trends-batter-chart',
      buildPlayerDatasets(
        filtered,
        allBatters,
        selectedBatters,
        batterMode,
        dailyPlayerBattingScores,
        orderedBatterDates
      ),
      yLabel,
      labels
    );
  }

  function drawPitcherChart() {
    const visible = getVisiblePitchers();
    const active = new Set([...selectedPitchers].filter((p) => visible.includes(p)));
    selectedPitchers = active;
    const filtered = pitchingData.filter((p) => mgrsForPitchers.has(p.manager));
    const yLabel =
      pitcherMode === 'daily' ? 'Daily Points' : pitcherMode === 'cumulative' ? 'Cumulative Points' : 'Weekly Points';
    const labels = pitcherMode === 'daily' ? pitcherDailyLabels : undefined;
    makeChart(
      'trends-pitcher-chart',
      buildPlayerDatasets(
        filtered,
        allPitchers,
        selectedPitchers,
        pitcherMode,
        dailyPlayerPitchingScores,
        orderedPitcherDates
      ),
      yLabel,
      labels
    );
  }

  // ---- Chip rendering ----
  function renderChips(containerId, items, selectedSet, onChange) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items
      .map(
        (item) =>
          `<button class="chip ${selectedSet.has(item) ? 'chip-active' : ''}" data-item="${esc(item)}">${esc(item)}</button>`
      )
      .join('');
    el.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        const val = chip.dataset.item;
        if (selectedSet.has(val)) selectedSet.delete(val);
        else selectedSet.add(val);
        chip.classList.toggle('chip-active');
        onChange();
      };
    });
  }

  function refreshBatterPlayerChips() {
    const visible = getVisibleBatters();
    // Initialise selectedBatters with first 8 if empty
    if (selectedBatters.size === 0) visible.slice(0, 8).forEach((p) => selectedBatters.add(p));
    renderChips('batter-chips', visible, selectedBatters, drawBatterChart);
  }

  function refreshPitcherPlayerChips() {
    const visible = getVisiblePitchers();
    if (selectedPitchers.size === 0) visible.slice(0, 8).forEach((p) => selectedPitchers.add(p));
    renderChips('pitcher-chips', visible, selectedPitchers, drawPitcherChart);
  }

  // ---- Initial chip renders ----
  renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);

  renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => {
    refreshBatterPlayerChips();
    drawBatterChart();
  });
  refreshBatterPlayerChips();

  renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => {
    refreshPitcherPlayerChips();
    drawPitcherChart();
  });
  refreshPitcherPlayerChips();

  // Initial chart draws
  drawManagerChart();

  // ---- Hover toggle ----
  function redrawActiveChart() {
    if (activePanel === 'managers') drawManagerChart();
    else if (activePanel === 'batters') {
      refreshBatterPlayerChips();
      drawBatterChart();
    } else {
      refreshPitcherPlayerChips();
      drawPitcherChart();
    }
  }
  document.getElementById('hover-focus-btn').onclick = () => {
    showAllOnHover = false;
    document.getElementById('hover-focus-btn').classList.add('active');
    document.getElementById('hover-all-btn').classList.remove('active');
    redrawActiveChart();
  };
  document.getElementById('hover-all-btn').onclick = () => {
    showAllOnHover = true;
    document.getElementById('hover-all-btn').classList.add('active');
    document.getElementById('hover-focus-btn').classList.remove('active');
    redrawActiveChart();
  };

  // ---- View toggle ----
  container.querySelectorAll('.trends-view-toggle .type-btn').forEach((btn) => {
    btn.onclick = () => {
      container.querySelectorAll('.trends-view-toggle .type-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      activePanel = view;
      document.getElementById('trends-managers-panel').style.display = view === 'managers' ? '' : 'none';
      document.getElementById('trends-batters-panel').style.display = view === 'batters' ? '' : 'none';
      document.getElementById('trends-pitchers-panel').style.display = view === 'pitchers' ? '' : 'none';
      if (view === 'managers') drawManagerChart();
      else if (view === 'batters') {
        refreshBatterPlayerChips();
        drawBatterChart();
      } else if (view === 'pitchers') {
        refreshPitcherPlayerChips();
        drawPitcherChart();
      }
    };
  });

  // ---- Mode toggle ----
  const setManagerMode = (mode) => {
    managerMode = mode;
    ['mode-weekly', 'mode-cumulative', 'mode-daily'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === `mode-${mode}`);
    });
    drawManagerChart();
  };
  document.getElementById('mode-weekly').onclick = () => setManagerMode('weekly');
  document.getElementById('mode-cumulative').onclick = () => setManagerMode('cumulative');
  if (hasDailyData) document.getElementById('mode-daily').onclick = () => setManagerMode('daily');

  const setBatterMode = (mode) => {
    batterMode = mode;
    ['bat-mode-daily', 'bat-mode-weekly', 'bat-mode-cumulative'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === `bat-mode-${mode}`);
    });
    refreshBatterPlayerChips();
    drawBatterChart();
  };
  if (hasDailyData) document.getElementById('bat-mode-daily').onclick = () => setBatterMode('daily');
  document.getElementById('bat-mode-weekly').onclick = () => setBatterMode('weekly');
  document.getElementById('bat-mode-cumulative').onclick = () => setBatterMode('cumulative');

  const setPitcherMode = (mode) => {
    pitcherMode = mode;
    ['pit-mode-daily', 'pit-mode-weekly', 'pit-mode-cumulative'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === `pit-mode-${mode}`);
    });
    refreshPitcherPlayerChips();
    drawPitcherChart();
  };
  if (hasDailyData) document.getElementById('pit-mode-daily').onclick = () => setPitcherMode('daily');
  document.getElementById('pit-mode-weekly').onclick = () => setPitcherMode('weekly');
  document.getElementById('pit-mode-cumulative').onclick = () => setPitcherMode('cumulative');

  // ---- All/None buttons ----
  document.getElementById('mgr-all-btn').onclick = () => {
    allManagers.forEach((m) => selectedManagers.add(m));
    renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);
    drawManagerChart();
  };
  document.getElementById('mgr-none-btn').onclick = () => {
    selectedManagers.clear();
    renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);
    drawManagerChart();
  };

  document.getElementById('bat-mgr-all-btn').onclick = () => {
    allManagers.forEach((m) => mgrsForBatters.add(m));
    renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => {
      refreshBatterPlayerChips();
      drawBatterChart();
    });
    refreshBatterPlayerChips();
    drawBatterChart();
  };
  document.getElementById('bat-mgr-none-btn').onclick = () => {
    mgrsForBatters.clear();
    renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => {
      refreshBatterPlayerChips();
      drawBatterChart();
    });
    selectedBatters.clear();
    refreshBatterPlayerChips();
    drawBatterChart();
  };
  document.getElementById('bat-all-btn').onclick = () => {
    getVisibleBatters().forEach((p) => selectedBatters.add(p));
    refreshBatterPlayerChips();
    drawBatterChart();
  };
  document.getElementById('bat-none-btn').onclick = () => {
    selectedBatters.clear();
    refreshBatterPlayerChips();
    drawBatterChart();
  };

  document.getElementById('pit-mgr-all-btn').onclick = () => {
    allManagers.forEach((m) => mgrsForPitchers.add(m));
    renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => {
      refreshPitcherPlayerChips();
      drawPitcherChart();
    });
    refreshPitcherPlayerChips();
    drawPitcherChart();
  };
  document.getElementById('pit-mgr-none-btn').onclick = () => {
    mgrsForPitchers.clear();
    renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => {
      refreshPitcherPlayerChips();
      drawPitcherChart();
    });
    selectedPitchers.clear();
    refreshPitcherPlayerChips();
    drawPitcherChart();
  };
  document.getElementById('pit-all-btn').onclick = () => {
    getVisiblePitchers().forEach((p) => selectedPitchers.add(p));
    refreshPitcherPlayerChips();
    drawPitcherChart();
  };
  document.getElementById('pit-none-btn').onclick = () => {
    selectedPitchers.clear();
    refreshPitcherPlayerChips();
    drawPitcherChart();
  };

  // ---- Pool filter buttons ----
  if (hasPools) {
    // Manager Trends pool buttons
    document.querySelectorAll('#trends-managers-panel .pool-filter-btn').forEach((btn) => {
      btn.onclick = () => {
        const pool = btn.dataset.pool;
        const poolMembers = poolGroups[pool] || [];
        selectedManagers.clear();
        poolMembers.forEach((m) => {
          if (allManagers.includes(m)) selectedManagers.add(m);
        });
        renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);
        drawManagerChart();
      };
    });

    // Batters pool buttons
    document.querySelectorAll('#trends-batters-panel .pool-filter-btn').forEach((btn) => {
      btn.onclick = () => {
        const pool = btn.dataset.pool;
        const poolMembers = poolGroups[pool] || [];
        mgrsForBatters.clear();
        poolMembers.forEach((m) => {
          if (allManagers.includes(m)) mgrsForBatters.add(m);
        });
        renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => {
          refreshBatterPlayerChips();
          drawBatterChart();
        });
        selectedBatters.clear();
        refreshBatterPlayerChips();
        drawBatterChart();
      };
    });

    // Pitchers pool buttons
    document.querySelectorAll('#trends-pitchers-panel .pool-filter-btn').forEach((btn) => {
      btn.onclick = () => {
        const pool = btn.dataset.pool;
        const poolMembers = poolGroups[pool] || [];
        mgrsForPitchers.clear();
        poolMembers.forEach((m) => {
          if (allManagers.includes(m)) mgrsForPitchers.add(m);
        });
        renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => {
          refreshPitcherPlayerChips();
          drawPitcherChart();
        });
        selectedPitchers.clear();
        refreshPitcherPlayerChips();
        drawPitcherChart();
      };
    });
  }
}

// ============================================================
// Scoring Engine
// ============================================================
// Convert IP from baseball notation to decimal: .1 -> .33, .2 -> .66
// convertIP, calculateBattingScore, calculatePitchingScore live in
// js/scoring.js (loaded via window globals by js/index.js).

// Return the ISO date (YYYY-MM-DD) one day before the given ISO date, tz-safe.
function dayBeforeISO(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Back-fill missing add/drop dates in roster_dates from approved swap records.
// Runs on every commissioner roster render so existing swaps (approved before this
// feature existed) also get their dates populated automatically.
//
// The swap record's own add_date/drop_date are authoritative when present — the server stamps
// them at submission/approval and they do NOT always straddle swap_date. When the outgoing or
// incoming player's team has already played today, or the manager scheduled the swap for a
// future date, the swap takes effect TOMORROW: add_date = swap_date + 1 and drop_date =
// swap_date. Only pre-add_date/drop_date legacy records fall back to the swap_date-derived
// window (out keeps credit through the day BEFORE swap_date; in starts ON swap_date), and only
// those get the self-heal for entries that stored the raw swap_date as the drop date.
function backfillRosterDatesFromSwaps(seasonData) {
  if (!seasonData || !seasonData.swaps) return false;
  const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let changed = false;
  for (const swap of seasonData.swaps) {
    if (swap.status !== 'approved' || !swap.week_key || !swap.swap_date || !swap.manager) continue;
    if (!seasonData.roster_dates) seasonData.roster_dates = {};
    if (!seasonData.roster_dates[swap.manager]) seasonData.roster_dates[swap.manager] = {};
    if (!seasonData.roster_dates[swap.manager][swap.week_key]) {
      seasonData.roster_dates[swap.manager][swap.week_key] = {};
    }
    const wkDates = seasonData.roster_dates[swap.manager][swap.week_key];
    const legacyDrop = dayBeforeISO(swap.swap_date);
    if (swap.player_out) {
      const stamped = isISO(swap.drop_date) ? swap.drop_date : null;
      const effectiveDrop = stamped || legacyDrop;
      if (!wkDates[swap.player_out]) wkDates[swap.player_out] = {};
      const cur = wkDates[swap.player_out].drop_date;
      // Fill when absent. Overwrite only to undo a known-bad value: the legacy raw-swap_date
      // entry (no stamped drop date), or a drop date this backfill itself mis-derived as
      // swap_date - 1 on an effective-tomorrow swap. A commissioner's manual edit to any other
      // date is left alone.
      const stale = cur === swap.swap_date && !stamped;
      const misDerived = !!stamped && cur === legacyDrop && stamped !== legacyDrop;
      if ((!cur || stale || misDerived) && cur !== effectiveDrop) {
        wkDates[swap.player_out].drop_date = effectiveDrop;
        changed = true;
      }
    }
    if (swap.player_in) {
      if (!wkDates[swap.player_in]) wkDates[swap.player_in] = {};
      if (!wkDates[swap.player_in].add_date) {
        wkDates[swap.player_in].add_date = isISO(swap.add_date) ? swap.add_date : swap.swap_date;
        changed = true;
      }
    }
  }
  return changed;
}

// Version stamp — bump whenever the repair logic changes substantially so the
// full-recompute pass runs again on next load. Mirrors server.js — bump both.
// v6: carry-forward now folds swaps effective in a trusted seed week into the
// baseline, so an in-season move made during the first week propagates forward.
// v7: carry-forward no longer crosses period (round) boundaries — a new period
// (PP2/QF/SF/Finals) starts fresh from its own submission, never the prior period's
// Week-5 roster (previously the boundary week was re-filled from carry-forward).
const ROSTER_REPAIR_VERSION = 7;

// Fill / recompute per-week roster entries by carrying forward the most recent
// trusted roster and applying approved swaps in chronological order.
//
// "Trusted" weeks: week 0 (initial submission) and any week in advanced_weeks
// (written by serverAutoAdvancePlayers).  All other past weeks are recomputed
// from the previous trusted/computed state + swap records whose swap_date falls
// in that week.  Using swap_date (rather than the stored week_key) is more
// reliable because week_key reflects which week was active at submission time,
// which may differ from the effective week when schedule_dates boundaries shift.
//
// On the first run after a version bump (roster_repair_version < ROSTER_REPAIR_VERSION)
// a full recompute runs to correct any weeks already populated by a previous
// broken repair pass.
function repairCarryForwardRosters(seasonData) {
  if (!seasonData || seasonData.status !== 'active' || !seasonData.rosters) return false;

  const approvedSwaps = (seasonData.swaps || []).filter((s) => s.status === 'approved');
  const scheduleDates = seasonData.schedule_dates || [];
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const legitimatelyAdvanced = new Set(seasonData.advanced_weeks || []);
  const needsFullRecompute = (seasonData.roster_repair_version || 0) < ROSTER_REPAIR_VERSION;
  let repaired = false;

  // Return the week_key that a swap's swap_date falls in, falling back to the stored week_key.
  function swapEffectiveWeekKey(swap) {
    if (swap.swap_date) {
      for (let j = 0; j < SEASON_SCHEDULE.length; j++) {
        const d = scheduleDates[j];
        if (d && swap.swap_date >= d.start && swap.swap_date <= d.end) {
          return `${SEASON_SCHEDULE[j].round}|${SEASON_SCHEDULE[j].week}`;
        }
      }
    }
    return swap.week_key;
  }

  function applySwaps(mgrName, weekKey, prevBatters, prevPitchers, newBatters, newPitchers) {
    approvedSwaps
      .filter((s) => s.manager === mgrName && swapEffectiveWeekKey(s) === weekKey)
      .forEach((s) => {
        if (s.player_out) {
          newBatters = newBatters.filter((p) => p !== s.player_out);
          newPitchers = newPitchers.filter((p) => p !== s.player_out);
        }
        if (s.player_in) {
          const wasBatter = s.player_out ? prevBatters.includes(s.player_out) : false;
          const wasPitcher = s.player_out ? prevPitchers.includes(s.player_out) : false;
          const inBatPool = (seasonData.batters_pool || []).includes(s.player_in);
          const inPitPool = (seasonData.pitchers_pool || []).includes(s.player_in);
          if (wasBatter && !newBatters.includes(s.player_in)) newBatters.push(s.player_in);
          else if (wasPitcher && !newPitchers.includes(s.player_in)) newPitchers.push(s.player_in);
          else if (inBatPool && !newBatters.includes(s.player_in)) newBatters.push(s.player_in);
          else if (inPitPool && !newPitchers.includes(s.player_in)) newPitchers.push(s.player_in);
        }
      });
    return { newBatters, newPitchers };
  }

  for (const [mgrName, mgrRoster] of Object.entries(seasonData.rosters)) {
    let prevBatters = null;
    let prevPitchers = null;

    for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
      const { round, week } = SEASON_SCHEDULE[i];
      const weekKey = `${round}|${week}`;

      // A new scoring period starts fresh from its own submission — never carry the prior
      // period's roster across a period (round) boundary (PP2/QF/SF/Finals Week 1). Reset the
      // carry-forward baseline so the boundary week is owned by its submission, not by the
      // previous period's Week-5 holdovers. (Mirrors the boundary skips already in the Sunday
      // auto-advance and managerWeekSubtotal's period-scoped eligibility.)
      if (i > 0 && SEASON_SCHEDULE[i].round !== SEASON_SCHEDULE[i - 1].round) {
        prevBatters = null;
        prevPitchers = null;
      }

      const weekStart = scheduleDates[i] ? scheduleDates[i].start : null;
      const isFuture = weekStart && weekStart > todayET;

      if (isFuture) {
        // Purge future weeks not written by the Sunday auto-advance.
        if (!legitimatelyAdvanced.has(i)) {
          const wr = mgrRoster[weekKey];
          if (wr && ((wr.batters || []).length > 0 || (wr.pitchers || []).length > 0)) {
            delete mgrRoster[weekKey];
            repaired = true;
          }
        }
        continue;
      }

      const wr = mgrRoster[weekKey];
      const hasBatters = wr && (wr.batters || []).length > 0;
      const hasPitchers = wr && (wr.pitchers || []).length > 0;
      const hasData = hasBatters || hasPitchers;

      // Trust week 0 (initial submission) and the first week with data (no prior
      // context to recompute from). Auto-advanced weeks are trusted only for
      // INCREMENTAL repairs — during a full recompute they are rebuilt from
      // carry-forward + swaps too, otherwise an auto-advanced current week never
      // picks up swaps made during it (and inherits staleness from the week it
      // was advanced from).
      const isTrusted = i === 0 || prevBatters === null || (legitimatelyAdvanced.has(i) && !needsFullRecompute);

      if (isTrusted) {
        if (hasData) {
          // A swap whose effective week is THIS trusted seed week (an in-season
          // move made during the first, or an auto-advanced, week) must still
          // advance the carry-forward baseline, or the swap-in never propagates
          // to later weeks. We leave mgrRoster[weekKey] untouched — the seed week
          // still scores the outgoing player for the days it rostered them via
          // roster_dates — and only advance prevBatters/prevPitchers.
          const seedBatters = [...(wr.batters || [])];
          const seedPitchers = [...(wr.pitchers || [])];
          ({ newBatters: prevBatters, newPitchers: prevPitchers } = applySwaps(
            mgrName,
            weekKey,
            seedBatters,
            seedPitchers,
            [...seedBatters],
            [...seedPitchers]
          ));
        }
      } else if (!hasData || needsFullRecompute) {
        // Recompute: either the week is empty, or the full-recompute pass is active
        // (corrects weeks that a previous broken repair already populated incorrectly).
        let newBatters = [...prevBatters];
        let newPitchers = [...prevPitchers];
        ({ newBatters, newPitchers } = applySwaps(
          mgrName,
          weekKey,
          prevBatters,
          prevPitchers,
          newBatters,
          newPitchers
        ));
        mgrRoster[weekKey] = { batters: newBatters, pitchers: newPitchers };
        repaired = true;
        prevBatters = newBatters;
        prevPitchers = newPitchers;
      } else {
        // Week has correct data and no recompute needed — just advance the tracking vars.
        prevBatters = [...(wr.batters || [])];
        prevPitchers = [...(wr.pitchers || [])];
      }
    }
  }

  if (needsFullRecompute) {
    seasonData.roster_repair_version = ROSTER_REPAIR_VERSION;
    repaired = true;
  }

  return repaired;
}

// Remove players from the Week 1 roster (and their stats/roster_dates) who appear there due
// to a stale initial-submission approval but are no longer in the manager's current approved
// initial_submission.  This catches the case where a manager changed their submission and the
// commissioner re-approved without the old cleanup path running (e.g. data pre-dating this fix).
// Players added by the commissioner via a swap record (player_in) are exempt from removal.
// Ghost players are identified from BOTH roster.batters AND roster_dates entries so that a
// manual removeFromRoster call (which removes from roster but leaves a roster_dates entry) is
// also cleaned up.  All stats — including drop_locked records — are purged for ghost players
// because they were never legitimately on the roster.
function repairGhostInitialRosterPlayers(seasonData) {
  if (!seasonData || !seasonData.initial_submissions || !seasonData.rosters) return false;
  const firstSched = SEASON_SCHEDULE[0];
  if (!firstSched) return false;
  const weekKey = `${firstSched.round}|${firstSched.week}`;
  let repaired = false;

  // Players involved in an approved Week-1 swap are legitimate, not ghosts:
  // player_in was commissioner-added, and player_out was genuinely rostered
  // before being swapped out (so the days they scored pre-drop must survive,
  // even when the recorded initial_submission is incomplete).
  const commAdded = new Set(
    (seasonData.swaps || [])
      .filter((s) => s.status === 'approved' && s.week_key === weekKey)
      .flatMap((s) => [s.player_in, s.player_out].filter(Boolean))
  );

  for (const [manager, sub] of Object.entries(seasonData.initial_submissions)) {
    // Only clean up when the submission has actual players listed (approved or pending re-sub).
    // Skip 'draft' / reset submissions where batters+pitchers are empty — we can't tell the
    // intended final roster yet, so leave the existing Week 1 roster alone.
    const hasPlayers = (sub.batters || []).length > 0 || (sub.pitchers || []).length > 0;
    if (!hasPlayers) continue;
    const mgrRoster = seasonData.rosters[manager];
    if (!mgrRoster || !mgrRoster[weekKey]) continue;

    const submittedBatters = new Set(sub.batters || []);
    const submittedPitchers = new Set(sub.pitchers || []);

    // Collect all players associated with this manager's Week 1 from BOTH sources:
    // the roster array AND roster_dates entries (a manual removeFromRoster call removes
    // from the roster array but leaves a roster_dates entry with drop_date).
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[manager] && seasonData.roster_dates[manager][weekKey]) || {};
    const allBattersPool = new Set(seasonData.batters_pool || []);
    const allPitchersPool = new Set(seasonData.pitchers_pool || []);

    const candidateBatters = new Set([
      ...(mgrRoster[weekKey].batters || []),
      ...Object.keys(weekRosterDates).filter((p) => allBattersPool.size === 0 || allBattersPool.has(p)),
    ]);
    const candidatePitchers = new Set([
      ...(mgrRoster[weekKey].pitchers || []),
      ...Object.keys(weekRosterDates).filter((p) => allPitchersPool.size > 0 && allPitchersPool.has(p)),
    ]);

    // Ghost = candidate not in submission AND not commissioner-added via swap
    const ghostBatters = [...candidateBatters].filter((b) => !submittedBatters.has(b) && !commAdded.has(b));
    const ghostPitchers = [...candidatePitchers].filter((p) => !submittedPitchers.has(p) && !commAdded.has(p));

    if (ghostBatters.length === 0 && ghostPitchers.length === 0) continue;

    [...ghostBatters, ...ghostPitchers].forEach((player) => {
      // Erase roster_dates entry — includes any drop_date set by a manual removeFromRoster call
      if (seasonData.roster_dates && seasonData.roster_dates[manager] && seasonData.roster_dates[manager][weekKey]) {
        delete seasonData.roster_dates[manager][weekKey][player];
      }
      // Purge ALL weekly stats for this player in Week 1 — including drop_locked records,
      // because drop_locked was set by removeFromRoster on a player who was never supposed
      // to be on the roster (the lock was set in error against a ghost).
      if (seasonData.weekly_batting) {
        seasonData.weekly_batting = seasonData.weekly_batting.filter(
          (b) => !(b.batter === player && b.round === firstSched.round && b.week === firstSched.week)
        );
      }
      if (seasonData.weekly_pitching) {
        seasonData.weekly_pitching = seasonData.weekly_pitching.filter(
          (p) => !(p.pitcher === player && p.round === firstSched.round && p.week === firstSched.week)
        );
      }
      if (seasonData.daily_batting) {
        seasonData.daily_batting = seasonData.daily_batting.filter(
          (b) => !(b.batter === player && b.round === firstSched.round && b.week === firstSched.week)
        );
      }
      if (seasonData.daily_pitching) {
        seasonData.daily_pitching = seasonData.daily_pitching.filter(
          (p) => !(p.pitcher === player && p.round === firstSched.round && p.week === firstSched.week)
        );
      }
    });

    mgrRoster[weekKey].batters = (mgrRoster[weekKey].batters || []).filter(
      (b) => submittedBatters.has(b) || commAdded.has(b)
    );
    mgrRoster[weekKey].pitchers = (mgrRoster[weekKey].pitchers || []).filter(
      (p) => submittedPitchers.has(p) || commAdded.has(p)
    );
    repaired = true;
  }
  return repaired;
}

// Repair any weekly data where 'manager' is an MLB team abbreviation instead of a WMMC manager name
function repairManagerAssignments(seasonData) {
  if (!seasonData || seasonData.status === 'completed') return false;

  const rosters = seasonData.rosters || {};
  let repaired = false;

  // Build SEPARATE typed lookups so batting stats are only repaired from the batters
  // roster and pitching stats only from the pitchers roster. A pitcher accidentally
  // placed in a manager's batters array must not cause that manager to inherit batting
  // stats for the pitcher (and vice versa for two-way players with distinct pool names).
  const batterToManager = {};
  const pitcherToManager = {};
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    if (Array.isArray(mgrRoster.batters) || Array.isArray(mgrRoster.pitchers)) {
      (mgrRoster.batters || []).forEach((b) => {
        batterToManager[b] = managerName;
      });
      (mgrRoster.pitchers || []).forEach((p) => {
        pitcherToManager[p] = managerName;
      });
    } else {
      for (const weekRoster of Object.values(mgrRoster)) {
        (weekRoster.batters || []).forEach((b) => {
          if (!batterToManager[b]) batterToManager[b] = managerName;
        });
        (weekRoster.pitchers || []).forEach((p) => {
          if (!pitcherToManager[p]) pitcherToManager[p] = managerName;
        });
      }
    }
  }

  // Only repair entries with null/empty manager (unassigned stats).
  // Never overwrite a valid stored manager — that would break banked points.
  (seasonData.weekly_batting || []).forEach((entry) => {
    if (!entry.manager) {
      const correctManager = batterToManager[entry.batter];
      if (correctManager) {
        entry.manager = correctManager;
        repaired = true;
      }
    }
  });

  (seasonData.weekly_pitching || []).forEach((entry) => {
    if (!entry.manager) {
      const correctManager = pitcherToManager[entry.pitcher];
      if (correctManager) {
        entry.manager = correctManager;
        repaired = true;
      }
    }
  });

  return repaired;
}

// Migrate old flat rosters { batters:[], pitchers:[] } to per-week format
// New format: rosters[manager] = { "PP1|Week 1": { batters:[], pitchers:[] }, ... }
function migrateRostersToWeekly(seasonData) {
  if (!seasonData || !seasonData.rosters) return;
  for (const [mgr, roster] of Object.entries(seasonData.rosters)) {
    // Detect old format: has .batters or .pitchers arrays directly
    if (Array.isArray(roster.batters) || Array.isArray(roster.pitchers)) {
      const batters = roster.batters || [];
      const pitchers = roster.pitchers || [];
      const newRoster = {};
      // Spread existing players into all weeks that have uploaded data
      const uploadedWeeks = new Set();
      (seasonData.weekly_batting || []).forEach((b) => {
        if (b.manager === mgr) uploadedWeeks.add(`${b.round}|${b.week}`);
      });
      (seasonData.weekly_pitching || []).forEach((p) => {
        if (p.manager === mgr) uploadedWeeks.add(`${p.round}|${p.week}`);
      });
      // If no uploaded weeks yet, put them in the first schedule week
      if (uploadedWeeks.size === 0 && SEASON_SCHEDULE.length > 0) {
        uploadedWeeks.add(`${SEASON_SCHEDULE[0].round}|${SEASON_SCHEDULE[0].week}`);
      }
      uploadedWeeks.forEach((wk) => {
        newRoster[wk] = { batters: [...batters], pitchers: [...pitchers] };
      });
      seasonData.rosters[mgr] = newRoster;
    }
  }
}

// Get the roster for a specific manager+week. Returns { batters:[], pitchers:[] }
function getWeekRoster(seasonData, managerName, round, week) {
  const rosters = (seasonData && seasonData.rosters) || {};
  const mgrRoster = rosters[managerName] || {};
  const weekKey = `${round}|${week}`;
  return mgrRoster[weekKey] || { batters: [], pitchers: [] };
}

// Get ALL unique players across all weeks for a manager (union of all weeks)
function getAllRosteredPlayers(seasonData, managerName) {
  const rosters = (seasonData && seasonData.rosters) || {};
  const mgrRoster = rosters[managerName] || {};
  const batters = new Set();
  const pitchers = new Set();
  for (const weekRoster of Object.values(mgrRoster)) {
    (weekRoster.batters || []).forEach((b) => batters.add(b));
    (weekRoster.pitchers || []).forEach((p) => pitchers.add(p));
  }
  return { batters: [...batters], pitchers: [...pitchers] };
}

// Build a player-to-manager lookup from rosters (union of all weeks)
// Find which manager owns a player for a SPECIFIC week
function findManagerForPlayerWeek(seasonData, playerName, type, round, week) {
  const rosters = seasonData.rosters || {};
  const rosterKey = type === 'batting' ? 'batters' : 'pitchers';
  const weekKey = `${round}|${week}`;
  const lc = String(playerName).toLowerCase();
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    const weekRoster = mgrRoster[weekKey];
    if (weekRoster && (weekRoster[rosterKey] || []).some((p) => p.toLowerCase() === lc)) {
      return managerName;
    }
  }
  return null;
}

// Build a lookup of "player|round|week" -> managerName from rosters + roster_dates.
// Used to attribute null-manager stats (players dropped mid-week) to the correct manager.
// Case-insensitive lookup key (player|round|week). Roster names are entered by the
// commissioner and may differ in case from the MLB feed name on a stat row; lowercasing both
// sides matches the case-insensitive server-side lookups so the web and Slack scoreboards
// agree. (Earlier this also defeated an esc()-vs-raw key mismatch in several call sites.)
function rosterLookupKey(name, round, week) {
  return `${String(name).toLowerCase()}|${round}|${week}`;
}

function buildRosterLookup(seasonData) {
  const lookup = {};
  const add = (name, round, week, mgr) => {
    const k = rosterLookupKey(name, round, week);
    if (!lookup[k]) lookup[k] = mgr;
  };
  for (const [mgr, mgrRosters] of Object.entries(seasonData.rosters || {})) {
    for (const [weekKey, weekRoster] of Object.entries(mgrRosters)) {
      const [round, week] = weekKey.split('|');
      (weekRoster.batters || []).forEach((p) => add(p, round, week, mgr));
      (weekRoster.pitchers || []).forEach((p) => add(p, round, week, mgr));
    }
  }
  for (const [mgr, mgrDates] of Object.entries(seasonData.roster_dates || {})) {
    for (const [weekKey, players] of Object.entries(mgrDates)) {
      const [round, week] = weekKey.split('|');
      Object.keys(players).forEach((p) => add(p, round, week, mgr));
    }
  }
  return lookup;
}

// Returns true if `player` was dropped from `mgr`'s roster (via a roster_dates entry in a
// previous week) before `weekKey` starts, and was not re-added during `weekKey`.
// Used to prevent carry-over players from accumulating points in subsequent weeks.
function playerDroppedBeforeWeek(seasonData, weekKeyToStart, mgr, player, weekKey) {
  const wkStart = weekKeyToStart[weekKey];
  if (!wkStart) return false;
  const mgrDates = (seasonData.roster_dates && seasonData.roster_dates[mgr]) || {};
  const addedThisWeek = !!(mgrDates[weekKey] && mgrDates[weekKey][player] && mgrDates[weekKey][player].add_date);
  if (addedThisWeek) return false;
  for (const [wk, players] of Object.entries(mgrDates)) {
    if (wk === weekKey) continue;
    const pd = players[player];
    if (pd && pd.drop_date && pd.drop_date < wkStart) {
      const reAddedLater = Object.values(mgrDates).some(
        (wkp) => wkp[player] && wkp[player].add_date > pd.drop_date && wkp[player].add_date < wkStart
      );
      if (!reAddedLater) return true;
    }
  }
  return false;
}

// Map of `${round}|${week}` -> week start date, used by the drop-eligibility checks.
// Defaults to the season the user is viewing; pass a season explicitly when computing for a
// DIFFERENT season than SELECTED_SEASON (the Hall of Fame does this — it walks every season).
function buildWeekKeyToStart(seasonData) {
  const scheduleDates = seasonData ? seasonData.schedule_dates || null : getScheduleDates();
  const map = {};
  SEASON_SCHEDULE.forEach((s, i) => {
    if (scheduleDates && scheduleDates[i]) map[`${s.round}|${s.week}`] = scheduleDates[i].start;
  });
  return map;
}

// Authoritative owner of a weekly stat row for scoring/seeding: the manager who actually
// rosters the player that week, derived from the roster (carry-forward + roster_dates) — NOT
// the cached `row.manager`, which can go stale after a re-sync and otherwise mis-credit
// pre-add or post-drop weeks. Because buildRosterLookup is built from the rosters + roster_dates,
// a lookup hit already implies membership, so this both excludes non-rostered weeks and credits
// the correct manager immediately after a trade. Returns the manager name, or null when the
// player isn't on anyone's roster that week. Single source of truth shared by the scoreboard,
// pool seeding, and playoff bracket math so they can't diverge.
function weeklyRowOwner(seasonData, rosterLookup, weekKeyToStart, row, playerKey) {
  const player = row[playerKey];
  const weekKey = `${row.round}|${row.week}`;
  const mgr = rosterLookup[rosterLookupKey(player, row.round, row.week)];
  if (!mgr) return null;
  if (playerDroppedBeforeWeek(seasonData, weekKeyToStart, mgr, player, weekKey)) return null;
  return mgr;
}

function computeManagerScores(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  const rosterLookup = buildRosterLookup(seasonData);
  const weekKeyToStart = buildWeekKeyToStart();

  const managerMap = {};
  batting.forEach((b) => {
    const mgr = weeklyRowOwner(seasonData, rosterLookup, weekKeyToStart, b, 'batter');
    if (!mgr) return;
    if (!managerMap[mgr]) managerMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
    managerMap[mgr].batting += b.weekly_score || 0;
  });
  pitching.forEach((p) => {
    const mgr = weeklyRowOwner(seasonData, rosterLookup, weekKeyToStart, p, 'pitcher');
    if (!mgr) return;
    if (!managerMap[mgr]) managerMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
    managerMap[mgr].pitching += p.weekly_score || 0;
  });

  return Object.values(managerMap).map((m) => {
    m.total = Math.round((m.batting + m.pitching) * 100) / 100;
    m.batting = Math.round(m.batting * 100) / 100;
    m.pitching = Math.round(m.pitching * 100) / 100;
    return m;
  });
}

function buildTeamWeekly(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  const managers = getManagers();
  const rosterLookup = buildRosterLookup(seasonData);

  const scheduleDates = getScheduleDates();
  const weekKeyToStart = {};
  SEASON_SCHEDULE.forEach((s, i) => {
    if (scheduleDates && scheduleDates[i]) weekKeyToStart[`${s.round}|${s.week}`] = scheduleDates[i].start;
  });

  // Build manager-to-pool lookup
  const managerPool = {};
  managers.forEach((m) => {
    if (m.pool) managerPool[m.name] = formatPool(m.pool);
  });

  const key = (r, w, m) => `${r}|${w}|${m}`;
  const map = {};

  batting.forEach((b) => {
    const mgr = b.manager || rosterLookup[rosterLookupKey(b.batter, b.round, b.week)];
    if (!mgr) return;
    const weekKey = `${b.round}|${b.week}`;
    if (playerDroppedBeforeWeek(seasonData, weekKeyToStart, mgr, b.batter, weekKey)) return;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.batters.includes(b.batter) && !weekRosterDates[b.batter]) return;
    const k = key(b.round, b.week, mgr);
    if (!map[k]) {
      map[k] = {
        round: b.round,
        week: b.week,
        manager: mgr,
        pool: managerPool[mgr] || '',
        weekly_batting: 0,
        weekly_pitching: 0,
        weekly_total: 0,
      };
    }
    map[k].weekly_batting += b.weekly_score || 0;
  });

  pitching.forEach((p) => {
    const mgr = p.manager || rosterLookup[rosterLookupKey(p.pitcher, p.round, p.week)];
    if (!mgr) return;
    const weekKey = `${p.round}|${p.week}`;
    if (playerDroppedBeforeWeek(seasonData, weekKeyToStart, mgr, p.pitcher, weekKey)) return;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.pitchers.includes(p.pitcher) && !weekRosterDates[p.pitcher]) return;
    const k = key(p.round, p.week, mgr);
    if (!map[k]) {
      map[k] = {
        round: p.round,
        week: p.week,
        manager: mgr,
        pool: managerPool[mgr] || '',
        weekly_batting: 0,
        weekly_pitching: 0,
        weekly_total: 0,
      };
    }
    map[k].weekly_pitching += p.weekly_score || 0;
  });

  const rows = Object.values(map).map((t) => {
    t.weekly_batting = Math.round(t.weekly_batting * 100) / 100;
    t.weekly_pitching = Math.round(t.weekly_pitching * 100) / 100;
    t.weekly_total = Math.round((t.weekly_batting + t.weekly_pitching) * 100) / 100;
    return t;
  });

  // Stamp per-round / whole-season cumulative totals and pool + overall ranks
  // for all nine metrics (see js/scoring.js).
  return enrichTeamWeekly(rows);
}

// ============================================================
// Season Schedule View
// ============================================================
// ============================================================
// Rosters Page
// ============================================================

function setupMyRoster() {
  if (!LOGGED_IN_EMAIL) return;

  const managers = getManagers();
  const loggedInMgr = managers.find((m) => m.email && m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase());
  if (!loggedInMgr) return;

  const isCommissioner = !!loggedInMgr.commissioner;
  const isActive = loggedInMgr.active !== false;
  const managerBar = document.getElementById('roster-manager-bar');
  const managerDropdown = document.getElementById('roster-manager-dropdown');
  const titleEl = document.getElementById('roster-title');

  managerBar.style.display = 'block';

  // Inactive non-commissioner managers cannot manage rosters
  if (!isActive && !isCommissioner) {
    managerDropdown.style.display = 'none';
    titleEl.style.display = '';
    titleEl.textContent = loggedInMgr.name + "'s Roster";
    document.getElementById('roster-content').innerHTML =
      '<div class="card"><p style="color:var(--text-muted);">Your account is currently inactive. Contact the commissioner to be reactivated.</p></div>';
    // The rail is persistent DOM, so it has to be emptied explicitly on this path —
    // renderRosterData (its only other writer) never runs for an inactive manager.
    const inactiveRail = document.getElementById('roster-score-rail');
    if (inactiveRail) inactiveRail.innerHTML = '';
    return;
  }

  if (isCommissioner) {
    // Preserve the roster the commissioner was viewing across re-renders (e.g. auto-poll)
    const prevSelection = managerDropdown._dd ? managerDropdown._dd.getValue() : '';

    // The dropdown button shows the manager name, so the separate title is redundant
    titleEl.style.display = 'none';
    managerDropdown.style.display = '';
    const options = [...managers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => {
        let label = m.name;
        if (m.commissioner) label += ' (Commissioner)';
        if (m.active === false) label += ' (Inactive)';
        return { value: m.name, label };
      });

    // Restore previous selection if still valid, otherwise default to logged-in user
    const selected = prevSelection && options.some((o) => o.value === prevSelection) ? prevSelection : loggedInMgr.name;
    buildCustomDropdown(managerDropdown, options, selected, (value) => renderRosterData(value, true));
  } else {
    // Regular manager: no dropdown needed
    managerDropdown.style.display = 'none';
    titleEl.style.display = '';
    titleEl.textContent = loggedInMgr.name + "'s Roster";
  }

  const displayName = isCommissioner ? managerDropdown._dd.getValue() : loggedInMgr.name;
  renderRosterData(displayName, isCommissioner);
}

// Custom dropdown replacing the native <select> roster picker. Android Chrome
// dark-themes native selects and ignores author text color, leaving the picker
// unreadable; this renders a styled button + list from regular DOM (which honors
// our CSS). The control's API is exposed on the container as container._dd:
// { getValue(), setValue(value, fire) }.
function buildCustomDropdown(container, options, selectedValue, onChange) {
  container.innerHTML = '';
  container.classList.add('custom-dd');
  let currentValue = options.some((o) => o.value === selectedValue)
    ? selectedValue
    : options.length
      ? options[0].value
      : '';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'form-select custom-dd-toggle';
  toggle.setAttribute('aria-haspopup', 'listbox');
  toggle.setAttribute('aria-expanded', 'false');
  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-dd-label';
  toggle.appendChild(labelSpan);

  const menu = document.createElement('ul');
  menu.className = 'custom-dd-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  const labelFor = (v) => {
    const o = options.find((x) => x.value === v);
    return o ? o.label : '';
  };
  const syncSelected = () => {
    labelSpan.textContent = labelFor(currentValue);
    [...menu.children].forEach((li) => {
      if (li.dataset.value === currentValue) li.setAttribute('aria-selected', 'true');
      else li.removeAttribute('aria-selected');
    });
  };

  const onDocClick = (e) => {
    if (!container.contains(e.target)) close();
  };
  function open() {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick);
  }
  function close() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
  }

  options.forEach((o) => {
    const li = document.createElement('li');
    li.className = 'custom-dd-option';
    li.setAttribute('role', 'option');
    li.dataset.value = o.value;
    li.textContent = o.label;
    li.addEventListener('click', () => {
      currentValue = o.value;
      syncSelected();
      close();
      if (onChange) onChange(currentValue);
    });
    menu.appendChild(li);
  });

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  container.appendChild(toggle);
  container.appendChild(menu);
  syncSelected();

  container._dd = {
    getValue: () => currentValue,
    setValue: (v, fire) => {
      if (!options.some((o) => o.value === v)) return;
      currentValue = v;
      syncSelected();
      if (fire && onChange) onChange(v);
    },
  };
}

// ============================================================
// My Roster — season scoring flow (Pool Play panel + playoff track)
// ============================================================
//
// Replaces the old flat row of stat cards. Pool play is one panel: the combined
// total as the hero number with PP1 and PP2 nested underneath as its two halves,
// plus a qualification chip. When the season has reached the bracket, a connector
// flows down into a QF -> SF -> Finals track, each node carrying that round's
// score and whether the manager advanced, went out, or is still playing.
//
// Round keys that roll up into one flow node. Historical seasons store the finals
// and 3rd-place weeks under their own round names (F1/F2, 3PWK1/3PWK2) and older
// imports use the 'PP1P'/'PP2P' variants, so each node sums every alias it owns.
const FLOW_ROUND_ALIASES = {
  PP1: ['PP1', 'PP1P'],
  PP2: ['PP2', 'PP2P'],
  QF: ['QF'],
  SF: ['SF'],
  Finals: ['Finals', 'F1', 'F2'],
  Third: ['3PWK1', '3PWK2'],
};

// Sum a set of computeRosterPeriodScores entries. Returns null when none of the
// keys have data, so callers can distinguish "not played yet" from "scored zero".
function sumFlowPeriods(periodScores, keys) {
  let bat = 0,
    pit = 0,
    found = false;
  keys.forEach((k) => {
    const s = periodScores[k];
    if (!s) return;
    found = true;
    bat += s.batting || 0;
    pit += s.pitching || 0;
  });
  if (!found) return null;
  bat = Math.round(bat * 100) / 100;
  pit = Math.round(pit * 100) / 100;
  return { batting: bat, pitching: pit, total: Math.round((bat + pit) * 100) / 100 };
}

// Final pass over a built track: promote the last node to its podium state and give
// every node its result label. Runs after the whole track is known because a
// semifinal loss reads "Lost" (not "Eliminated") when a 3rd-place game follows it.
function labelFlowStates(flow) {
  const rounds = flow.rounds;
  const last = rounds[rounds.length - 1];
  const thirdGame = !!last && last.label === '3rd Place Game';
  if (last && last.key === 'Finals') {
    if (last.state === 'won') last.state = thirdGame ? 'third' : 'champion';
    else if (last.state === 'lost' && !thirdGame) last.state = 'runner-up';
  }
  const FLAGS = {
    won: 'Advanced',
    lost: 'Eliminated',
    champion: 'Champion',
    'runner-up': 'Runner-Up',
    third: '3rd Place',
    live: 'In progress',
    upcoming: 'Upcoming',
    locked: 'TBD',
    out: 'Out',
    played: '',
  };
  rounds.forEach((r, i) => {
    if (r.state === 'lost' && thirdGame) r.flag = i === rounds.length - 1 ? '4th Place' : 'Lost';
    else r.flag = FLAGS[r.state] || '';
  });
  return flow;
}

// Derive the whole flow for one manager.
//
// Scoring invariant: every number rendered here still comes from
// computeRosterPeriodScores (i.e. managerWeekSubtotal over the date-windowed,
// period-scoped rosters) — the same values the old stat cards showed. The only
// additional reads are the opponent's round total and who advanced, which come
// from roundBreakdown/roundMatchupWinner — the Playoff Bracket card's own source —
// so this panel can never disagree with the bracket about a result. Nothing here
// writes to seasonData.
function buildRosterScoreFlow(managerName, seasonData, periodScores) {
  const pp1 = sumFlowPeriods(periodScores, FLOW_ROUND_ALIASES.PP1);
  const pp2 = sumFlowPeriods(periodScores, FLOW_ROUND_ALIASES.PP2);
  const flow = {
    pool: sumFlowPeriods(periodScores, [...FLOW_ROUND_ALIASES.PP1, ...FLOW_ROUND_ALIASES.PP2]) || {
      batting: 0,
      pitching: 0,
      total: 0,
    },
    pp1,
    pp2,
    hasPoolData: !!(pp1 || pp2),
    status: null,
    rounds: [],
    showPlayoffs: false,
    eliminatedInPool: false,
  };

  // ---- Historical season: the bracket snapshot is the record ----
  if (DATA && DATA.team_weekly) {
    const b = (DATA && DATA.bracket) || null;
    const seedIdx = b && Array.isArray(b.seeds) ? b.seeds.findIndex((s) => s.manager === managerName) : -1;
    const seed = seedIdx >= 0 ? seedIdx + 1 : null;
    if (b) {
      flow.status =
        seed != null
          ? { kind: 'qualified', label: `Qualified · #${seed} seed` }
          : { kind: 'missed', label: 'Missed the playoffs' };
      flow.eliminatedInPool = seed == null;
      flow.showPlayoffs = seed != null;
    }
    if (!b || seed == null) return flow;

    const inMatch = (m) => !!m && (m.manager1 === managerName || m.manager2 === managerName);
    const mkHist = (key, label, m, score) => {
      if (!inMatch(m)) return { key, label, score, state: score ? 'played' : 'out' };
      const meFirst = m.manager1 === managerName;
      return {
        key,
        label,
        score,
        state: m.winner === managerName ? 'won' : 'lost',
        opponent: meFirst ? m.manager2 : m.manager1,
        opponentScore: meFirst ? m.score2 : m.score1,
      };
    };
    const find = (list) => (list || []).find(inMatch) || null;

    flow.rounds.push(mkHist('QF', 'Quarterfinals', find(b.qf_matchups), sumFlowPeriods(periodScores, ['QF'])));
    flow.rounds.push(mkHist('SF', 'Semifinals', find(b.sf_matchups), sumFlowPeriods(periodScores, ['SF'])));

    // The final slot is whichever game they actually played — the championship or,
    // for a semifinal loser, the 3rd-place game (its own weeks in team_weekly).
    flow.rounds.push(
      inMatch(b.consolation)
        ? mkHist('Finals', '3rd Place Game', b.consolation, sumFlowPeriods(periodScores, FLOW_ROUND_ALIASES.Third))
        : mkHist('Finals', 'Finals', b.finals, sumFlowPeriods(periodScores, FLOW_ROUND_ALIASES.Finals))
    );
    return labelFlowStates(flow);
  }

  if (!seasonData || seasonData.status === 'completed') return flow;

  // ---- Active season ----
  const finalized = new Set(seasonData.finalized_rounds || []);
  const ppFinal = finalized.has('PP');
  const seeding = getSeeding(seasonData);
  const seedEntry = seeding ? seeding.seeds.find((s) => s.manager === managerName) : null;
  const seed = seedEntry ? seedEntry.seed : null;
  const inField = !!(seeding && seeding.qualifierNames.includes(managerName));

  if (seeding && flow.hasPoolData) {
    const wonPP1 = !!(seeding.pp1Leaders && seeding.pp1Leaders.has(managerName));
    const wonPP2 = !!(seeding.pp2Leaders && seeding.pp2Leaders.has(managerName));
    const isWildcard = !!(seeding.wildcardSet && seeding.wildcardSet.has(managerName));
    const note =
      wonPP1 && wonPP2
        ? 'Won both pool periods'
        : wonPP1
          ? 'Won Pool Play 1'
          : wonPP2
            ? 'Won Pool Play 2'
            : isWildcard
              ? 'Wild card'
              : '';
    if (ppFinal) {
      flow.status = inField
        ? { kind: 'qualified', label: `Qualified · #${seed} seed`, note }
        : { kind: 'missed', label: 'Missed the playoffs' };
    } else {
      flow.status = inField
        ? { kind: 'projected', label: `Projected · #${seed} seed`, note }
        : { kind: 'projected-out', label: 'Outside the playoff field' };
    }
  }
  flow.eliminatedInPool = ppFinal && !!seeding && !inField;

  const rosterLookup = buildRosterLookup(seasonData);
  const weekKeyToStart = buildWeekKeyToStart();
  const seedRank = seedRankLookup(seasonData);

  // The manager's matchup in a playoff round, or null when the round's participants
  // aren't determined yet (prior round not finalized) or they aren't in it.
  const myMatchup = (round) => {
    const matchups = playoffRoundMatchups(seasonData, round);
    if (!matchups) return null;
    for (const m of matchups) {
      const i = m.teams.findIndex((t) => t.name === managerName);
      if (i >= 0) return { label: m.label, opponent: m.teams[1 - i].name };
    }
    return null;
  };

  let knockedOut = flow.eliminatedInPool;
  [
    { key: 'QF', label: 'Quarterfinals' },
    { key: 'SF', label: 'Semifinals' },
    { key: 'Finals', label: 'Finals' },
  ].forEach((r) => {
    const score = sumFlowPeriods(periodScores, FLOW_ROUND_ALIASES[r.key]);
    const mine = myMatchup(r.key);
    if (!mine) {
      flow.rounds.push({ key: r.key, label: r.label, score, state: knockedOut ? 'out' : score ? 'played' : 'locked' });
      return;
    }
    const isThird = mine.label === '3rd Place';
    const label = r.key === 'Finals' && isThird ? '3rd Place Game' : r.label;
    const opponentScore = roundBreakdown(seasonData, mine.opponent, r.key, rosterLookup, weekKeyToStart).total;
    if (!finalized.has(r.key)) {
      flow.rounds.push({
        key: r.key,
        label,
        score,
        state: score && score.total ? 'live' : 'upcoming',
        opponent: mine.opponent,
        opponentScore,
      });
      return;
    }
    const myTotal = roundBreakdown(seasonData, managerName, r.key, rosterLookup, weekKeyToStart).total;
    const won = roundMatchupWinner(managerName, myTotal, mine.opponent, opponentScore, seedRank) === managerName;
    if (!won) knockedOut = true;
    flow.rounds.push({
      key: r.key,
      label,
      score,
      state: won ? 'won' : 'lost',
      opponent: mine.opponent,
      opponentScore,
    });
  });

  flow.showPlayoffs = !flow.eliminatedInPool && (ppFinal || flow.rounds.some((r) => r.score));
  return labelFlowStates(flow);
}

// Render the flow built above into the roster page's right-hand score rail. Pure
// presentation — no data derivation here.
//
// The rail is a narrow vertical column (see .roster-layout / .score-rail in styles.css),
// so everything is a one-or-two-line row rather than a wide card: pool play stacks its
// total over PP1/PP2, and the playoff rounds stack beneath it as compact score rows.
// Once the bracket is underway pool play is settled history, so it renders in a compact
// mode (smaller total, no Bat/Pit on the PP1/PP2 rows) and stops out-shouting the round
// that is actually being played.
function renderRosterScoreFlow(flow) {
  if (!flow.hasPoolData && !flow.rounds.some((r) => r.score)) return '';

  const split = (s) => (s ? `Bat ${fmt(s.batting)}<span class="sf-sep">·</span>Pit ${fmt(s.pitching)}` : '');

  const CHIP_TEXT = {
    qualified: '✓',
    projected: '◎',
    missed: '✕',
    'projected-out': '◌',
  };
  const chip = flow.status
    ? `<span class="sf-chip sf-chip-${flow.status.kind}">
         <span class="sf-chip-mark" aria-hidden="true">${CHIP_TEXT[flow.status.kind] || ''}</span>
         <span class="sf-chip-text">${esc(flow.status.label)}${
           flow.status.note ? `<span class="sf-chip-note">${esc(flow.status.note)}</span>` : ''
         }</span>
       </span>`
    : '';

  // Pool play recedes once it can no longer change: the bracket has scores, or seeding
  // is final (qualified/missed) — as opposed to a still-projected seed mid-pool-play.
  const settledStatus = flow.status && (flow.status.kind === 'qualified' || flow.status.kind === 'missed');
  const poolCompact = !!(settledStatus || flow.rounds.some((r) => r.score));

  const sub = (label, s) => `<div class="sf-sub${s ? '' : ' sf-sub-empty'}">
      <span class="sf-sub-label">${label}</span>
      <span class="sf-sub-value">${s ? fmt(s.total) : '—'}</span>
      <span class="sf-sub-split">${split(s)}</span>
    </div>`;

  let html = '<div class="score-rail">';

  html += `<div class="sf-pool${poolCompact ? ' sf-pool-compact' : ''}">
    <div class="sf-pool-head">
      <span class="sf-eyebrow">Pool Play</span>
      ${chip}
    </div>
    <div class="sf-hero">
      <span class="sf-hero-value">${fmt(flow.pool.total)}</span>
      <span class="sf-hero-split">${split(flow.pool)}</span>
    </div>
    <div class="sf-subs">
      ${sub('Pool Play 1', flow.pp1)}
      ${sub('Pool Play 2', flow.pp2)}
    </div>
  </div>`;

  if (flow.eliminatedInPool) {
    html += `<div class="sf-season-over">Season Over</div>`;
    return html + '</div>';
  }

  if (!flow.showPlayoffs) return html + '</div>';

  const WON_STATES = new Set(['won', 'champion', 'third']);
  html += '<div class="sf-rounds"><div class="sf-rounds-label">Playoffs</div><div class="sf-rounds-list">';
  flow.rounds.forEach((r) => {
    let vs = '';
    if (r.opponent) {
      const verb = WON_STATES.has(r.state) ? 'def.' : r.state === 'lost' || r.state === 'runner-up' ? 'lost to' : 'vs';
      vs = `<div class="sf-round-vs">${verb} <span class="sf-round-opp">${esc(r.opponent)}</span>${
        r.opponentScore != null ? ` <span class="sf-round-oppscore">${fmt(r.opponentScore)}</span>` : ''
      }</div>`;
    }
    // A round with no score yet drops the Bat/Pit line entirely so the placeholder
    // row stays a single line instead of reserving space for a score it doesn't have.
    html += `<div class="sf-round sf-state-${r.state}${r.score ? '' : ' sf-round-empty'}">
      <div class="sf-round-head">
        <span class="sf-eyebrow">${esc(r.label)}</span>
        ${r.flag ? `<span class="sf-flag">${esc(r.flag)}</span>` : ''}
      </div>
      <div class="sf-round-body">
        <span class="sf-round-value">${r.score ? fmt(r.score.total) : '—'}</span>
        ${r.score ? `<span class="sf-round-split">${split(r.score)}</span>` : ''}
      </div>
      ${vs}
    </div>`;
  });
  html += '</div></div>';

  return html + '</div>';
}

function renderRosterData(managerName, isCommissioner) {
  const container = document.getElementById('roster-content');
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  const isActive = seasonData && seasonData.status === 'active';

  // Migrate old flat rosters to per-week format if needed
  if (isActive) migrateRostersToWeekly(seasonData);
  // Ensure roster_dates has drop/add dates for all approved swaps.
  // Automatic render-time saves: silent so a stale-rev 409 never alerts/reloads (it re-runs next render).
  if (isActive && backfillRosterDatesFromSwaps(seasonData)) saveSeason(SELECTED_SEASON, seasonData, { silent: true });
  // Fill / recompute per-week roster entries by carrying forward the last known roster.
  if (isActive && repairCarryForwardRosters(seasonData)) saveSeason(SELECTED_SEASON, seasonData, { silent: true });

  // Compute per-period scores for this manager
  const periodScores = computeRosterPeriodScores(managerName, seasonData);

  let html = '';

  // ---- Elimination Roast Banner ----
  const roast = seasonData && seasonData.roasts && seasonData.roasts[managerName];
  if (roast) {
    const roundLabel =
      roast.round === 'PP'
        ? 'Pool Play'
        : roast.round === 'QF'
          ? 'Quarterfinals'
          : roast.round === 'SF'
            ? 'Semifinals'
            : roast.round === 'Finals'
              ? 'Finals'
              : roast.round;
    // page_context is the longer, page-only follow-up (Pool Play standings + player
    // highlights) added alongside the punchy joke that also goes to Slack — Slack keeps
    // just roast.text since the combined post already stacks one roast per manager.
    // Paragraphs are joined with a blank line server-side; render each as its own <p>.
    // Blank lines separate sections; single newlines separate the lines within one. A section
    // may open with a `[[Section label]]` marker (buildRoastPageContext emits one per round
    // the manager played — Pool Play, Quarterfinals…); pull it out and render it as a heading
    // chip, then hang that round's tables (scoring days, top performers, bottom performers)
    // underneath it from roast.page_tables, keyed by the same label.
    //
    // Sections without a marker, and roasts stored before page_tables existed, render exactly
    // as they always did — the tables are additive, never required.
    const asLines = (s) => esc(s).replace(/\n/g, '<br>');
    const roastTables = roast.page_tables && typeof roast.page_tables === 'object' ? roast.page_tables : {};
    const tableHtml = (t) => {
      // A column with an empty header still gets a <th> so the header row and the body stay
      // aligned; it just renders blank (used for the H/P position tag).
      const head = t.columns.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = t.rows
        .map(
          (r) =>
            `<tr class="${r.low ? 'roast-table-low' : ''}">${r.cells
              .map((c, i) => `<td${i === 0 ? ' class="roast-table-name"' : ''}>${esc(String(c ?? ''))}</td>`)
              .join('')}</tr>`
        )
        .join('');
      return `<div class="roast-table"><div class="roast-table-title">${esc(t.title)}</div><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    };
    const tablesFor = (label) => {
      const ts = roastTables[label];
      return Array.isArray(ts) && ts.length ? `<div class="roast-tables">${ts.map(tableHtml).join('')}</div>` : '';
    };
    const contextHtml = roast.page_context
      ? `<div class="roast-context">${roast.page_context
          .split('\n\n')
          .map((p) => {
            const m = p.match(/^\[\[([^\]]+)\]\]\s*([\s\S]*)$/);
            return m
              ? `<p><span class="roast-context-label">${esc(m[1])}</span>${asLines(m[2])}</p>${tablesFor(m[1])}`
              : `<p>${asLines(p)}</p>`;
          })
          .join('')}</div>`
      : '';
    // outcome distinguishes the standard "you're out" roast from the Finals-round podium
    // roasts (champion, runner-up, 3rd place — the three next-year pool captains) — those
    // aren't a Hall of Shame entry, they get their own icon/label/tint (see
    // .roast-banner.roast-champion/.roast-runner-up/.roast-third in styles.css).
    const outcome = roast.outcome || 'eliminated';
    const PODIUM_BANNER = {
      champion: {
        cls: 'roast-champion',
        flame: '🏆',
        label: 'CHAMPION &mdash; Whit Merrifield Memorial Cup Winner (sort of a big deal)',
      },
      runner_up: { cls: 'roast-runner-up', flame: '🥈', label: 'RUNNER-UP &mdash; So Close, Yet So Far' },
      third: { cls: 'roast-third', flame: '🥉', label: '3RD PLACE &mdash; A Real Accomplishment*' },
    };
    const podium = PODIUM_BANNER[outcome];
    const bannerClass = podium ? `roast-banner ${podium.cls}` : 'roast-banner';
    const flame = podium ? podium.flame : '🔥';
    const label = podium ? podium.label : `HALL OF SHAME &mdash; Eliminated in ${esc(roundLabel)}`;
    html += `<div class="${bannerClass}">
      <div class="roast-header">
        <span class="roast-flame">${flame}</span>
        <span class="roast-label">${label}</span>
      </div>
      <div class="roast-text">${esc(roast.text)}</div>
      ${contextHtml}
    </div>`;
  }

  // ---- PP2 Submission Incomplete Warning ----
  if (isActive && isPeriodTimeOpen(seasonData, 'pp2')) {
    const pp2Sub = getPeriodSub(seasonData, 'pp2', managerName);
    const pp2Done = pp2Sub && (pp2Sub.status === 'pending' || pp2Sub.status === 'approved');
    if (!pp2Done) {
      html += `<div class="submission-warning">
        <span class="submission-warning-icon">⚠️</span>
        <span>Your <strong>Pool Play 2</strong> lineup has not been submitted. Go to the <a href="#" onclick="switchRosterTab(document.querySelector('[data-rtab=\\'swaps\\']'),'swaps');return false;">Swaps tab</a> to submit.</span>
      </div>`;
    }
  }

  // ---- Season Scoring Rail ----
  // The per-round score blocks live in the right-hand rail (#roster-score-rail, under the
  // manager picker), not inline above the tabs. The rail is a persistent node — it also
  // holds the commissioner's custom dropdown, whose state must survive a re-render — so it
  // is written directly here rather than through `container`'s innerHTML below.
  const rail = document.getElementById('roster-score-rail');
  if (rail) rail.innerHTML = renderRosterScoreFlow(buildRosterScoreFlow(managerName, seasonData, periodScores));

  // Preserve the active tab when re-rendering
  const activeTabBtn = document.querySelector('.roster-tab.active');
  const activeTabKey = activeTabBtn ? activeTabBtn.dataset.rtab : 'per-week';

  // ---- Roster Tabs ----
  html += `<div class="roster-tabs">
    <button class="roster-tab${activeTabKey === 'per-week' ? ' active' : ''}" data-rtab="per-week" onclick="switchRosterTab(this, 'per-week')">Roster</button>
    <button class="roster-tab${activeTabKey === 'team-stats' ? ' active' : ''}" data-rtab="team-stats" onclick="switchRosterTab(this, 'team-stats')">Team Stats</button>
    <button class="roster-tab${activeTabKey === 'swaps' ? ' active' : ''}" data-rtab="swaps" onclick="switchRosterTab(this, 'swaps')">Swaps</button>
  </div>`;

  // ---- Per-Week Roster Sections ----
  // The per-week tables window a swapped player's stats to their rostered dates using daily
  // rows, which are fetched on demand. First render falls back to weekly totals; re-render
  // once when the daily data lands.
  ensureDailyStats(SELECTED_SEASON, () => renderRosterData(managerName, isCommissioner));
  html += `<div class="roster-tab-content" id="rtab-per-week" style="display:${activeTabKey === 'per-week' ? 'block' : 'none'};">`;
  html += buildPerWeekRoster(managerName, isCommissioner, seasonData);
  html += `</div>`;

  // ---- Team Stats Breakdown ----
  html += `<div class="roster-tab-content" id="rtab-team-stats" style="display:${activeTabKey === 'team-stats' ? 'block' : 'none'};">`;
  html += buildTeamStatsBreakdown(managerName, seasonData);
  html += `</div>`;

  // ---- Player Swaps ----
  html += `<div class="roster-tab-content" id="rtab-swaps" style="display:${activeTabKey === 'swaps' ? 'block' : 'none'};">`;
  html += buildPlayerSwapsSection(managerName, isCommissioner, seasonData);
  html += `</div>`;

  container.innerHTML = html;
  // Late-submission state is the server's to decide (SUBMISSION_WINDOWS). Ask AFTER painting, so
  // the page never waits on the network, and re-render only if an answer actually moved — which
  // is what turns a closed period back into a late-mode form.
  if (isActive) {
    refreshSubmissionWindows(['pp1', 'pp2', 'qf', 'sf', 'finals'], () => renderRosterData(managerName, isCommissioner));
  }
  // The Swaps tab's "All Swaps" list is the shared swap log scoped to this manager — it renders
  // into its container after the innerHTML above, and keeps its own expand/filter state.
  renderSwapLog(ROSTER_SWAP_LOG_ID, false, managerName);
  // Initialize type-to-search inputs after DOM is rendered
  setupPlayerSearchInputs();
  setupSwapPlayerSearch();
  // Initialize commissioner roster management view if present
  if (document.getElementById('comm-roster-week')) {
    window.updateCommRosterWeekView(managerName);
  }
}

// Compute cumulative scores for all players within a single scoring period (round),
// across all managers. Used for period-scoped CUM RANK computation.
// maxWeek (optional): only include weeks up to and including this week (e.g. "Week 3").
function computePeriodCumulativeScores(seasonData, round, maxWeek) {
  const maxWeekNum = maxWeek ? parseInt(maxWeek.split(' ')[1]) || Infinity : Infinity;
  const batCumulative = {},
    pitCumulative = {};
  (seasonData.weekly_batting || []).forEach((b) => {
    if (b.round !== round || !b.batter) return;
    const weekNum = parseInt((b.week || '').split(' ')[1]) || 0;
    if (weekNum > maxWeekNum) return;
    batCumulative[b.batter] = (batCumulative[b.batter] || 0) + (b.weekly_score || 0);
  });
  (seasonData.weekly_pitching || []).forEach((p) => {
    if (p.round !== round || !p.pitcher) return;
    const weekNum = parseInt((p.week || '').split(' ')[1]) || 0;
    if (weekNum > maxWeekNum) return;
    pitCumulative[p.pitcher] = (pitCumulative[p.pitcher] || 0) + (p.weekly_score || 0);
  });
  for (const k of Object.keys(batCumulative)) batCumulative[k] = Math.round(batCumulative[k] * 100) / 100;
  for (const k of Object.keys(pitCumulative)) pitCumulative[k] = Math.round(pitCumulative[k] * 100) / 100;
  return { batCumulative, pitCumulative };
}

// Compute weekly rankings for all players in a given week
function computeWeeklyRankings(seasonData, round, week) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const weekBatScores = {};
  batting
    .filter((b) => b.round === round && b.week === week)
    .forEach((b) => {
      if (!b.batter) return;
      weekBatScores[b.batter] = Math.max(weekBatScores[b.batter] || 0, b.weekly_score || 0);
    });

  const weekPitScores = {};
  pitching
    .filter((p) => p.round === round && p.week === week)
    .forEach((p) => {
      if (!p.pitcher) return;
      weekPitScores[p.pitcher] = Math.max(weekPitScores[p.pitcher] || 0, p.weekly_score || 0);
    });

  // Sort and rank
  const batSorted = Object.entries(weekBatScores).sort((a, b) => b[1] - a[1]);
  const batRanks = {};
  batSorted.forEach(([name], i) => {
    batRanks[name] = { rank: i + 1, total: batSorted.length };
  });

  const pitSorted = Object.entries(weekPitScores).sort((a, b) => b[1] - a[1]);
  const pitRanks = {};
  pitSorted.forEach(([name], i) => {
    pitRanks[name] = { rank: i + 1, total: pitSorted.length };
  });

  return { batRanks, pitRanks };
}

// Compute cumulative rankings for all players across all weeks
function computeCumulativeRankings(batCumulative, pitCumulative) {
  const batSorted = Object.entries(batCumulative).sort((a, b) => b[1] - a[1]);
  const batRanks = {};
  batSorted.forEach(([name], i) => {
    batRanks[name] = { rank: i + 1, total: batSorted.length };
  });

  const pitSorted = Object.entries(pitCumulative).sort((a, b) => b[1] - a[1]);
  const pitRanks = {};
  pitSorted.forEach(([name], i) => {
    pitRanks[name] = { rank: i + 1, total: pitSorted.length };
  });

  return { batRanks, pitRanks };
}

// Build per-week roster sections showing batters and pitchers for each week
function buildPerWeekRoster(managerName, isCommissioner, seasonData) {
  const isActive = !!(seasonData && seasonData.status === 'active');
  const isHistorical = !!(DATA && DATA.batting_weekly);
  // Every roster view reads its date windows AS OF today, so a scheduled (future-dated) swap
  // never reads as already applied: the outgoing player stays on the roster — and keeps
  // scoring — until their drop date, and the incoming player shows as scheduled until theirs.
  const todayISO = isoDateET(new Date());

  const batting = isHistorical ? DATA.batting_weekly || [] : seasonData.weekly_batting || [];
  const pitching = isHistorical ? DATA.pitching_weekly || [] : seasonData.weekly_pitching || [];

  // Per-round cache: CUM PTS = player's total in this round (up to maxWeek) while on this manager's roster.
  // CUM RANK = league-wide rank within the same period up to maxWeek.
  const roundDataCache = {};
  function getRoundData(round, maxWeek) {
    const cacheKey = `${round}|${maxWeek}`;
    if (roundDataCache[cacheKey]) return roundDataCache[cacheKey];
    const maxWeekNum = maxWeek ? parseInt(maxWeek.split(' ')[1]) || Infinity : Infinity;
    const sourceData = isActive ? seasonData : { weekly_batting: batting, weekly_pitching: pitching };
    // Use the season's own arrays (not DATA.batting_weekly) to avoid historical bleed.
    const cumBatting = isActive ? seasonData.weekly_batting || [] : batting;
    const cumPitching = isActive ? seasonData.weekly_pitching || [] : pitching;
    // For null-manager entries, only count them if the player was on THIS manager's roster
    // for that specific week (roster array or roster_dates entry). This lets dropped players
    // whose stats arrived post-drop count correctly while excluding other managers' unattributed stats.
    const mgrRosters = isActive ? (seasonData.rosters || {})[managerName] || {} : {};
    const mgrRosterDates = isActive ? (seasonData.roster_dates || {})[managerName] || {} : {};

    // Precompute weekKey → start date to efficiently filter carry-over players.
    const weekKeyToStart = {};
    SEASON_SCHEDULE.forEach((s, i) => {
      if (scheduleDates && scheduleDates[i]) weekKeyToStart[`${s.round}|${s.week}`] = scheduleDates[i].start;
    });

    function wasRosteredThisWeek(player, weekKey, type) {
      if (isActive && playerDroppedBeforeWeek(seasonData, weekKeyToStart, managerName, player, weekKey)) return false;
      const wkRoster = mgrRosters[weekKey] || { batters: [], pitchers: [] };
      const arr = type === 'bat' ? wkRoster.batters : wkRoster.pitchers;
      if (arr.includes(player)) return true;
      const wkDates = mgrRosterDates[weekKey] || {};
      return !!wkDates[player];
    }
    const batCum = {},
      pitCum = {};
    cumBatting.forEach((b) => {
      if (b.round !== round || !b.batter) return;
      const weekNum = parseInt((b.week || '').split(' ')[1]) || 0;
      if (weekNum > maxWeekNum) return;
      const weekKey = `${b.round}|${b.week}`;
      if (!wasRosteredThisWeek(b.batter, weekKey, 'bat')) return;
      if (b.manager === managerName || b.manager === null) {
        batCum[b.batter] = (batCum[b.batter] || 0) + (b.weekly_score || 0);
      }
    });
    cumPitching.forEach((p) => {
      if (p.round !== round || !p.pitcher) return;
      const weekNum = parseInt((p.week || '').split(' ')[1]) || 0;
      if (weekNum > maxWeekNum) return;
      const weekKey = `${p.round}|${p.week}`;
      if (!wasRosteredThisWeek(p.pitcher, weekKey, 'pit')) return;
      if (p.manager === managerName || p.manager === null) {
        pitCum[p.pitcher] = (pitCum[p.pitcher] || 0) + (p.weekly_score || 0);
      }
    });
    for (const k of Object.keys(batCum)) batCum[k] = Math.round(batCum[k] * 100) / 100;
    for (const k of Object.keys(pitCum)) pitCum[k] = Math.round(pitCum[k] * 100) / 100;
    // League-wide period cumulative for CUM RANK (bounded to same maxWeek)
    const periodScores = computePeriodCumulativeScores(sourceData, round, maxWeek);
    const periodRankings = computeCumulativeRankings(periodScores.batCumulative, periodScores.pitCumulative);
    roundDataCache[cacheKey] = { batCum, pitCum, periodRankings };
    return roundDataCache[cacheKey];
  }

  // Available players for commissioner add
  // Swap log and schedule dates for inline date annotations
  const approvedSwaps = isActive
    ? (seasonData.swaps || []).filter((s) => s.manager === managerName && s.status === 'approved')
    : [];
  const scheduleDates = getScheduleDates();
  // First week's start date is the season boundary: swaps recorded before this date are pre-season
  const seasonStartDate = scheduleDates && scheduleDates[0] ? scheduleDates[0].start : null;

  // Which list a player belongs in. Needed to put a player the (derived) roster arrays dropped
  // early — a scheduled swap's outgoing player — back into the right table. Mirrors the pool-based
  // classification in rebuildRosterArraysFromDates, falling back to the arrays and the stat rows.
  const batPool = new Set(seasonData ? seasonData.batters_pool || [] : []);
  const pitPool = new Set(seasonData ? seasonData.pitchers_pool || [] : []);
  function poolTypeOf(player) {
    const inBat = batPool.has(player);
    const inPit = pitPool.has(player);
    if (inBat && !inPit) return 'batters';
    if (inPit && !inBat) return 'pitchers';
    const mgrRoster = (isActive && seasonData.rosters && seasonData.rosters[managerName]) || {};
    for (const wr of Object.values(mgrRoster)) {
      if ((wr.batters || []).includes(player)) return 'batters';
      if ((wr.pitchers || []).includes(player)) return 'pitchers';
    }
    if (batting.some((b) => b.batter === player)) return 'batters';
    if (pitching.some((p) => p.pitcher === player)) return 'pitchers';
    return null;
  }

  // Get inline date tag for a player in a given week. A date still in the future belongs to a
  // SCHEDULED swap, so it reads in the future tense ("Drops Jul 30") — the move has not happened.
  function playerDateTag(player, weekKey, weekIdx) {
    if (!scheduleDates || !scheduleDates[weekIdx]) return '';
    const weekDates = scheduleDates[weekIdx];

    // Check roster_dates first (commissioner-editable), then swap records, then week range
    const rd =
      isActive &&
      seasonData.roster_dates &&
      seasonData.roster_dates[managerName] &&
      seasonData.roster_dates[managerName][weekKey] &&
      seasonData.roster_dates[managerName][weekKey][player];

    const tags = [];
    let scheduled = false;
    const tagFor = (verbPast, verbFuture, date) => {
      if (date > todayISO) scheduled = true;
      return `${date > todayISO ? verbFuture : verbPast} ${fmtShortDate(date)}`;
    };
    if (rd && rd.add_date) {
      tags.push(tagFor('Added', 'Adds', rd.add_date));
    } else {
      const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
      if (addSwap && addSwap.swap_date) tags.push(tagFor('Added', 'Adds', addSwap.swap_date));
    }
    if (rd && rd.drop_date) {
      tags.push(tagFor('Dropped', 'Drops', rd.drop_date));
    } else {
      const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
      if (dropSwap && dropSwap.swap_date) tags.push(tagFor('Dropped', 'Drops', dropSwap.swap_date));
    }
    if (tags.length === 0) {
      return ` <span class="roster-date-tag">${fmtDateRangeShort(weekDates.start, weekDates.end)}</span>`;
    }
    const cls = `roster-date-tag roster-date-swap${scheduled ? ' roster-date-scheduled' : ''}`;
    return ` <span class="${cls}">${tags.join(' · ')}</span>`;
  }

  // For a dropped player, show the date range they were rostered (e.g. "5/4–5/6") in the
  // same grey-box style as the "not rostered" tag.  Falls back to "not rostered" only when
  // no date information is available at all.
  function notRosteredTag(player, poolType, round) {
    if (!isActive || !seasonData.rosters || !seasonData.rosters[managerName]) {
      return ' <span class="wrs-hist-tag">not rostered</span>';
    }

    // Prefer specific add/drop dates stored in roster_dates. A player can be rostered in more
    // than one span (added, swapped out, swapped back in), so pair adds→drops chronologically
    // and render every span, e.g. "5/4–5/21, 6/2–". A drop with no open add (e.g. a pre-season /
    // orphan drop made before the submission-edit feature existed) produces no span and falls
    // through to the schedule-based fallback below (→ "not rostered").
    if (seasonData.roster_dates && seasonData.roster_dates[managerName]) {
      const events = [];
      for (const weekDates of Object.values(seasonData.roster_dates[managerName])) {
        const entry = weekDates[player];
        if (!entry) continue;
        if (entry.add_date) events.push({ date: entry.add_date, type: 'add' });
        if (entry.drop_date) events.push({ date: entry.drop_date, type: 'drop' });
      }
      // Chronological; on a same-day tie, an add sorts before a drop.
      events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === 'add' ? -1 : 1));
      const spans = [];
      let openAdd = null;
      for (const ev of events) {
        if (ev.type === 'add') {
          if (openAdd === null) openAdd = ev.date;
        } else if (openAdd !== null) {
          spans.push([openAdd, ev.date]);
          openAdd = null;
        }
      }
      if (openAdd !== null) spans.push([openAdd, null]);
      // A new submission period starts fresh from its submission — a player carried forward
      // from an earlier period shouldn't display their out-of-period add date, and a span that
      // closed entirely before this period began doesn't belong here at all. Clamp/filter to
      // the period this round belongs to (mirrors periodStart scoping used for carry-forward
      // eligibility elsewhere in this file).
      const periodStart = periodStartForSeason(seasonData, round);
      const scopedSpans = periodStart
        ? spans.filter(([, d]) => !d || d >= periodStart).map(([a, d]) => [a < periodStart ? periodStart : a, d])
        : spans;
      if (scopedSpans.length > 0) {
        const label = scopedSpans
          .map(([a, d]) => (d ? `${fmtSlashDate(a)}–${fmtSlashDate(d)}` : `${fmtSlashDate(a)}–`))
          .join(', ');
        return ` <span class="wrs-hist-tag">${label}</span>`;
      }
    }

    // Fall back to week-schedule-based date range, scoped to this round's period.
    const mgrRoster = seasonData.rosters[managerName];
    const rosteredWeekIndices = [];
    SEASON_SCHEDULE.forEach((s, i) => {
      if (round && s.round !== round) return;
      const wk = `${s.round}|${s.week}`;
      const wr = mgrRoster[wk];
      const arr = poolType ? wr && (wr[poolType] || []) : wr && (wr.batters || []).concat(wr.pitchers || []);
      if (arr && arr.includes(player)) rosteredWeekIndices.push(i);
    });
    if (rosteredWeekIndices.length === 0 || !scheduleDates) {
      return ' <span class="wrs-hist-tag">not rostered</span>';
    }
    const firstIdx = rosteredWeekIndices[0];
    const lastIdx = rosteredWeekIndices[rosteredWeekIndices.length - 1];
    const startDate = scheduleDates[firstIdx] ? scheduleDates[firstIdx].start : null;
    const endDate = scheduleDates[lastIdx] ? scheduleDates[lastIdx].end : null;
    if (!startDate || !endDate) {
      return ' <span class="wrs-hist-tag">not rostered</span>';
    }
    return ` <span class="wrs-hist-tag">${fmtSlashDate(startDate)}–${fmtSlashDate(endDate)}</span>`;
  }

  // Determine which weeks have roster data or uploaded stats for this manager
  const weeksWithData = new Set();
  batting.filter((b) => b.manager === managerName).forEach((b) => weeksWithData.add(`${b.round}|${b.week}`));
  pitching.filter((p) => p.manager === managerName).forEach((p) => weeksWithData.add(`${p.round}|${p.week}`));

  // Also include weeks where this manager has a non-empty per-week roster
  if (isActive && seasonData.rosters && seasonData.rosters[managerName]) {
    Object.entries(seasonData.rosters[managerName]).forEach(([wk, wr]) => {
      if ((wr.batters || []).length > 0 || (wr.pitchers || []).length > 0) weeksWithData.add(wk);
    });
  }

  // Build ordered list: SEASON_SCHEDULE order, most recent first
  const scheduleOrder = {};
  SEASON_SCHEDULE.forEach((s, i) => {
    scheduleOrder[`${s.round}|${s.week}`] = i;
  });
  const orderedWeeks = SEASON_SCHEDULE.map((s) => `${s.round}|${s.week}`);
  // Only show weeks that have data or non-empty rosters (same for all users — showing all
  // schedule weeks for commissioners caused empty "No batters rostered" sections for
  // future weeks that haven't been advanced yet).
  const weeksToShow = orderedWeeks.filter((wk) => weeksWithData.has(wk));

  if (weeksToShow.length === 0) return '<div class="card"><p class="text-muted">No roster data yet.</p></div>';

  // Find the latest week with data for highlighting
  let latestDataWeek = null;
  for (let i = orderedWeeks.length - 1; i >= 0; i--) {
    if (weeksWithData.has(orderedWeeks[i])) {
      latestDataWeek = orderedWeeks[i];
      break;
    }
  }

  // Determine the "current" week from today's date + the season schedule (falling back to the
  // latest week that has data). The open section then tracks the real calendar week rather than
  // just the last week we happen to have stats for.
  let currentWeekKey = null;
  if (isActive) {
    const cur = getCurrentScheduleRound(seasonData);
    if (cur && cur.weekKey && weeksToShow.includes(cur.weekKey)) currentWeekKey = cur.weekKey;
  }
  if (!currentWeekKey) currentWeekKey = latestDataWeek;

  // Build each week's section HTML into a map keyed by weekKey; the grouped/nested layout is
  // assembled from these below (Pool Play → PP1/PP2 → week; playoff weeks flat).
  const weekHtml = {};
  const weekTotals = {};

  // Show weeks in chronological order, the current week expanded
  weeksToShow.forEach((weekKey) => {
    let html = '';
    const [round, week] = weekKey.split('|');
    const schedEntry = SEASON_SCHEDULE.find((s) => s.round === round && s.week === week);
    const label = schedEntry ? schedEntry.label : `${round} - ${week}`;
    const weekIdx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
    const isCurrent = weekKey === currentWeekKey;

    // Get roster for this week
    let weekRoster = isActive ? getWeekRoster(seasonData, managerName, round, week) : { batters: [], pitchers: [] };

    // Get stat records for this week
    const weekBatting = batting.filter((b) => b.manager === managerName && b.round === round && b.week === week);
    const weekPitching = pitching.filter((p) => p.manager === managerName && p.round === round && p.week === week);

    // Build complete historical roster sets for this week from all sources:
    // current roster, roster_dates (commissioner add/drop), and approved swaps.
    const weekRosterDates =
      isActive && seasonData.roster_dates && seasonData.roster_dates[managerName]
        ? seasonData.roster_dates[managerName][weekKey] || {}
        : {};

    // Filter out players who were dropped (recorded in a previous week's roster_dates) before
    // this week's start date, so they don't carry over into future weeks.
    const weekStart = scheduleDates && scheduleDates[weekIdx] ? scheduleDates[weekIdx].start : null;
    if (weekStart && isActive && seasonData.roster_dates && seasonData.roster_dates[managerName]) {
      const allMgrDates = seasonData.roster_dates[managerName];
      const addedThisWeek = new Set([
        ...approvedSwaps.filter((s) => s.player_in && s.week_key === weekKey).map((s) => s.player_in),
        ...Object.entries(weekRosterDates)
          .filter(([, d]) => d.add_date)
          .map(([p]) => p),
      ]);
      const wasDroppedBefore = (player) => {
        if (addedThisWeek.has(player)) return false;
        for (const [wk, players] of Object.entries(allMgrDates)) {
          if (wk === weekKey) continue;
          const pd = players[player];
          if (pd && pd.drop_date && pd.drop_date < weekStart) {
            const reAddedLater = Object.values(allMgrDates).some(
              (wkp) => wkp[player] && wkp[player].add_date > pd.drop_date && wkp[player].add_date < weekStart
            );
            if (!reAddedLater) return true;
          }
        }
        return false;
      };
      weekRoster = {
        batters: weekRoster.batters.filter((p) => !wasDroppedBefore(p)),
        pitchers: weekRoster.pitchers.filter((p) => !wasDroppedBefore(p)),
      };
    }
    // A SCHEDULED swap is recorded (and applied to the derived roster arrays) the moment it is
    // submitted, even though its dates are in the future. Re-derive both ends from the date
    // windows AS OF today so the swap doesn't take effect early in this view:
    //   pendingDrop — outgoing player, still rostered and still scoring until their drop date.
    //                 applySwapToSeason already pulled them out of the week's array, so put them
    //                 back; roster_dates is the source of truth, the arrays are a derived cache.
    //   pendingAdd  — incoming player, already in the array but not on the roster until their
    //                 add date. Listed (so the move is visible) but not counted as active.
    const periodStartThisRound = periodStartForSeason(seasonData, round);
    const statusAsOfToday = (player) => {
      const entries = [];
      for (const wkDates of Object.values((isActive && (seasonData.roster_dates || {})[managerName]) || {})) {
        if (wkDates[player]) entries.push(wkDates[player]);
      }
      return rosterStatusAsOf(entries, { periodStart: periodStartThisRound, asOf: todayISO });
    };
    const pendingDrop = new Set();
    const pendingAdd = new Set();
    if (isActive) {
      for (const [p, d] of Object.entries(weekRosterDates)) {
        if (d.drop_date && d.drop_date > todayISO && statusAsOfToday(p) === 'active') pendingDrop.add(p);
        if (d.add_date && d.add_date > todayISO && statusAsOfToday(p) === 'scheduled') pendingAdd.add(p);
      }
    }
    if (pendingDrop.size > 0) {
      const restore = (listKey) =>
        [...pendingDrop].filter((p) => poolTypeOf(p) === listKey && !weekRoster[listKey].includes(p));
      weekRoster = {
        batters: weekRoster.batters.concat(restore('batters')),
        pitchers: weekRoster.pitchers.concat(restore('pitchers')),
      };
    }

    // Players dropped during this week (drop_date present in current weekRosterDates) are treated
    // as historical/greyed-out, the same as players dropped in a previous week — unless the drop
    // is still scheduled, in which case they are simply on the roster.
    const droppedThisWeek = new Set(
      Object.entries(weekRosterDates)
        .filter(([p, d]) => d.drop_date && !pendingDrop.has(p))
        .map(([p]) => p)
    );

    // Pool membership is an autocomplete hint, not a stats filter — a player on
    // the manager's actual roster always belongs in this set, even if their name
    // doesn't line up exactly with sd.batters_pool / sd.pitchers_pool (e.g., a
    // diacritic difference between the MLB catalog and the roster slot). Otherwise
    // the per-week subtotals diverge from computeRosterPeriodScores' period total.
    const historicalBatters = new Set([
      ...weekRoster.batters,
      ...Object.keys(weekRosterDates).filter(
        (p) => !seasonStartDate || !weekRosterDates[p].drop_date || weekRosterDates[p].drop_date >= seasonStartDate
      ),
      ...approvedSwaps
        .filter(
          (s) =>
            s.player_in &&
            s.week_key === weekKey &&
            (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
            (weekRosterDates[s.player_in] ||
              batting.some((b) => b.batter === s.player_in && b.round === round && b.week === week))
        )
        .map((s) => s.player_in),
    ]);
    const historicalPitchers = new Set([
      ...weekRoster.pitchers,
      ...Object.keys(weekRosterDates).filter(
        (p) => !seasonStartDate || !weekRosterDates[p].drop_date || weekRosterDates[p].drop_date >= seasonStartDate
      ),
      ...approvedSwaps
        .filter(
          (s) =>
            s.player_in &&
            s.week_key === weekKey &&
            (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
            (weekRosterDates[s.player_in] ||
              pitching.some((p) => p.pitcher === s.player_in && p.round === round && p.week === week))
        )
        .map((s) => s.player_in),
    ]);

    // Extend weekly stats with unattributed entries for historically rostered players.
    // Stats synced after a drop arrive with manager = null and would otherwise be invisible.
    const allWeekBatting = weekBatting.slice();
    if (isActive) {
      batting.forEach((b) => {
        if (
          b.round === round &&
          b.week === week &&
          !b.manager &&
          historicalBatters.has(b.batter) &&
          !allWeekBatting.some((x) => x.batter === b.batter)
        ) {
          allWeekBatting.push(b);
        }
      });
    }
    const allWeekPitching = weekPitching.slice();
    if (isActive) {
      pitching.forEach((p) => {
        if (
          p.round === round &&
          p.week === week &&
          !p.manager &&
          historicalPitchers.has(p.pitcher) &&
          !allWeekPitching.some((x) => x.pitcher === p.pitcher)
        ) {
          allWeekPitching.push(p);
        }
      });
    }
    // Only show dropped players who actually banked points during the
    // rostered window of this week. Their stats may still include games
    // played outside the window (the underlying weekly_pitching row carries
    // cumulative stats for every game of the week), but if weekly_score
    // resolves to 0 the row is noise — hide it to match "show stats only
    // when the player could earn points".
    const playerWeekScore = (rows, key, name) => {
      const row = rows.find((r) => r[key] === name);
      return row ? row.weekly_score || 0 : 0;
    };

    // …but a player who was genuinely on the roster for part of this week belongs in the week's
    // table whether or not those days produced anything. A swap that lands mid-week leaves the
    // outgoing player rostered for the days before it; the points gate above dropped them from
    // the view entirely when their in-window games were blank — or when the sync never wrote a
    // weekly row for them at all — so a swapped-out player vanished from the very week they were
    // swapped out of, even though the scoreboard still listed them. Read the window from this
    // week's roster_dates entry (the source of truth), falling back to the approved swap that
    // moved them, and keep the player when that window overlaps the week at all.
    const weekEnd = scheduleDates && scheduleDates[weekIdx] ? scheduleDates[weekIdx].end : null;
    function rosteredDuringWeek(player) {
      const rd = weekRosterDates[player];
      const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
      const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
      if (!rd && !addSwap && !dropSwap) return false;
      const addDate = (rd && rd.add_date) || (addSwap && addSwap.swap_date) || null;
      const dropDate = (rd && rd.drop_date) || (dropSwap && dropSwap.swap_date) || null;
      // A drop recorded before the season started is a pre-season orphan, not a window.
      if (seasonStartDate && dropDate && dropDate < seasonStartDate) return false;
      if (addDate && weekEnd && addDate > weekEnd) return false;
      if (dropDate && weekStart && dropDate < weekStart) return false;
      return true;
    }
    // The eligibility sets span both lists (roster_dates keys are type-agnostic), so a
    // statless player is only placed by their own pool type.
    const droppedBatters = [...historicalBatters].filter((p) => {
      if (weekRoster.batters.includes(p) && !droppedThisWeek.has(p)) return false;
      const scored = allWeekBatting.some((b) => b.batter === p) && playerWeekScore(allWeekBatting, 'batter', p) > 0;
      return scored || (poolTypeOf(p) === 'batters' && rosteredDuringWeek(p));
    });
    const droppedPitchers = [...historicalPitchers].filter((p) => {
      if (weekRoster.pitchers.includes(p) && !droppedThisWeek.has(p)) return false;
      const scored =
        allWeekPitching.some((pt) => pt.pitcher === p) && playerWeekScore(allWeekPitching, 'pitcher', p) > 0;
      return scored || (poolTypeOf(p) === 'pitchers' && rosteredDuringWeek(p));
    });

    // Compute weekly rankings for this week
    const weekRanks = computeWeeklyRankings(
      isActive ? seasonData : { weekly_batting: batting, weekly_pitching: pitching },
      round,
      week
    );

    // Compute week totals — use the extended arrays (which include null-manager entries
    // for historically rostered players dropped mid-week) filtered to valid historical sets.
    const batTotal = allWeekBatting
      .filter((b) => historicalBatters.has(b.batter))
      .reduce((s, b) => s + (b.weekly_score || 0), 0);
    const pitTotal = allWeekPitching
      .filter((p) => historicalPitchers.has(p.pitcher))
      .reduce((s, p) => s + (p.weekly_score || 0), 0);
    const weekTotal = Math.round((batTotal + pitTotal) * 100) / 100;

    const safeId = weekKey.replace(/[^a-zA-Z0-9]/g, '_');
    const headerClass = isCurrent ? 'wrs-header wrs-current' : 'wrs-header';
    const bodyDisplay = isCurrent ? 'block' : 'none';
    const openClass = isCurrent ? ' wrs-open' : '';

    html += `<div class="wrs-section">
      <div class="${headerClass}${openClass}" onclick="toggleWeeklyScoring('${safeId}')">
        <span class="wrs-header-label">${isCurrent ? '(Current) ' : ''}${label}</span>
        <span class="wrs-header-pts">${weekTotal > 0 ? fmt(weekTotal) + ' PTS' : 'No stats'}</span>
      </div>
      <div class="wrs-body" id="wrs-body-${safeId}" style="display:${bodyDisplay};">`;

    // Helper: render a stat cell, highlighting manually edited fields
    function batStatCell(s, field, displayVal) {
      const manual = (s.manual_fields || []).includes(field);
      return `<td class="num${manual ? ' stat-manual' : ''}">${displayVal}</td>`;
    }

    // Returns batting stats filtered to the player's rostered date window (add_date/drop_date).
    // Falls back to null when no daily records exist, so callers use the weekly totals instead.
    const getEffBatStats = (player) => {
      let addDate = null,
        dropDate = null;
      const rd = weekRosterDates[player];
      if (rd) {
        addDate = rd.add_date || null;
        dropDate = rd.drop_date || null;
      }
      if (!addDate) {
        const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
        if (addSwap && addSwap.swap_date) addDate = addSwap.swap_date;
      }
      if (!dropDate) {
        const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
        if (dropSwap && dropSwap.swap_date) dropDate = dropSwap.swap_date;
      }
      if (!addDate && !dropDate) return null;
      const dailyStats = getDailyStatsCached(SELECTED_SEASON);
      const daily = ((dailyStats && dailyStats.batting) || []).filter(
        (r) => r.batter === player && r.round === round && r.week === week
      );
      if (!daily.length) return null;
      const eligible = daily.filter((r) => {
        if (addDate && r.date < addDate) return false;
        if (dropDate && r.date > dropDate) return false;
        return true;
      });
      const t = { abs: 0, '1b': 0, '2b': 0, '3b': 0, hr: 0, r: 0, rbi: 0, sb: 0, bb: 0 };
      for (const rec of eligible) {
        const d = rec.delta || {};
        for (const k of Object.keys(t)) t[k] += d[k] || 0;
      }
      return t;
    };

    // Same as getEffBatStats but for pitchers.
    const getEffPitStats = (player) => {
      let addDate = null,
        dropDate = null;
      const rd = weekRosterDates[player];
      if (rd) {
        addDate = rd.add_date || null;
        dropDate = rd.drop_date || null;
      }
      if (!addDate) {
        const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
        if (addSwap && addSwap.swap_date) addDate = addSwap.swap_date;
      }
      if (!dropDate) {
        const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
        if (dropSwap && dropSwap.swap_date) dropDate = dropSwap.swap_date;
      }
      if (!addDate && !dropDate) return null;
      const dailyStats = getDailyStatsCached(SELECTED_SEASON);
      const daily = ((dailyStats && dailyStats.pitching) || []).filter(
        (r) => r.pitcher === player && r.round === round && r.week === week
      );
      if (!daily.length) return null;
      const eligible = daily.filter((r) => {
        if (addDate && r.date < addDate) return false;
        if (dropDate && r.date > dropDate) return false;
        return true;
      });
      const t = { gs: 0, w: 0, qs: 0, cg: 0, cgso: 0, nh: 0, ip: 0, h: 0, er: 0, bb: 0, k: 0 };
      for (const rec of eligible) {
        const d = rec.delta || {};
        for (const k of Object.keys(t)) t[k] += d[k] || 0;
      }
      return t;
    };

    // ---- Batters for this week ----
    // A scheduled add is listed but not yet counted — the roster is still the pre-swap one.
    const activeBatCount = weekRoster.batters.filter((p) => !droppedThisWeek.has(p) && !pendingAdd.has(p)).length;
    html += `<div class="wrs-group-label">BATTERS (${activeBatCount}) <span class="wrs-group-pts">${fmt(Math.round(batTotal * 100) / 100)} pts</span></div>`;

    // Build batter stat lookup for this week
    const batStatMap = {};
    allWeekBatting.forEach((b) => {
      batStatMap[b.batter] = b;
    });

    // Pool filter: only show batting stats for players in historicalBatters (already pool-validated)
    const weekBattingForTable = allWeekBatting.filter((b) => historicalBatters.has(b.batter));
    const currentBatRoster = new Set(weekRoster.batters.filter((p) => !droppedThisWeek.has(p)));
    const allBattersThisWeek = new Set([
      ...currentBatRoster,
      ...droppedBatters,
      // Stat rows that aren't currently rostered only earn a slot if they
      // actually banked points — keeps a player's post-drop games from
      // showing as a stat line with WK PTS = 0.
      ...weekBattingForTable
        .filter((b) => currentBatRoster.has(b.batter) || (b.weekly_score || 0) > 0)
        .map((b) => b.batter),
    ]);
    if (allBattersThisWeek.size > 0) {
      html += '<div class="table-wrapper"><table class="data-table compact-table wrs-table"><thead><tr>';
      html +=
        '<th>Player</th><th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th>';
      html += '</tr></thead><tbody>';
      // Same swap-chain ordering as the scoreboard detail panel: a swapped-in batter renders
      // directly beneath the batter he replaced instead of wherever his score lands.
      const batScoreByPlayer = {};
      allBattersThisWeek.forEach((p) => (batScoreByPlayer[p] = (batStatMap[p] || {}).weekly_score || 0));
      orderWithSwapChains([...allBattersThisWeek], batScoreByPlayer, approvedSwaps, managerName).forEach((batter) => {
        const s = batStatMap[batter] || {};
        const isScheduled = pendingAdd.has(batter);
        const onRoster = !isScheduled && weekRoster.batters.includes(batter) && !droppedThisWeek.has(batter);
        const wkRank = weekRanks.batRanks[batter];
        const { batCum, periodRankings: pRankings } = getRoundData(round, week);
        const cumScore = batCum[batter] || 0;
        const cumRank = pRankings.batRanks[batter];
        html += `<tr${isScheduled ? ' class="wrs-sched-row"' : onRoster ? '' : ' class="wrs-hist-row"'}>`;
        const batTag =
          isScheduled || onRoster ? playerDateTag(batter, weekKey, weekIdx) : notRosteredTag(batter, 'batters', round);
        html += `<td>${displayPlayer(batter, seasonData)}${batTag}</td>`;
        const ds = getEffBatStats(batter) || s;
        html += batStatCell(s, 'abs', ds.abs || 0);
        html += batStatCell(s, '1b', ds['1b'] || 0);
        html += batStatCell(s, '2b', ds['2b'] || 0);
        html += batStatCell(s, '3b', ds['3b'] || 0);
        html += batStatCell(s, 'hr', ds.hr || 0);
        html += batStatCell(s, 'r', ds.r || 0);
        html += batStatCell(s, 'rbi', ds.rbi || 0);
        html += batStatCell(s, 'sb', ds.sb || 0);
        html += batStatCell(s, 'bb', ds.bb || 0);
        html += `<td class="num"><strong>${fmt(s.weekly_score || 0)}</strong></td>`;
        html += `<td class="num rank-cell">${wkRank ? wkRank.rank + '/' + wkRank.total : '-'}</td>`;
        html += `<td class="num"><strong>${fmt(cumScore)}</strong></td>`;
        html += `<td class="num rank-cell">${cumRank ? cumRank.rank + '/' + cumRank.total : '-'}</td>`;
        html += '</tr>';
      });
      html += `</tbody><tfoot><tr class="wrs-subtotal-row">
        <td colspan="9"></td>
        <td class="wrs-subtotal-label">Batting Total</td>
        <td class="num wrs-subtotal-val"><strong>${fmt(Math.round(batTotal * 100) / 100)}</strong></td>
        <td colspan="3"></td>
      </tr></tfoot></table></div>`;
    } else {
      html += '<p class="text-muted" style="font-size:0.85rem;">No batters rostered this week.</p>';
    }

    // Helper: render a pitching stat cell with manual highlight
    function pitStatCell(s, field, displayVal) {
      const manual = (s.manual_fields || []).includes(field);
      return `<td class="num${manual ? ' stat-manual' : ''}">${displayVal}</td>`;
    }

    // ---- Pitchers for this week ----
    const activePitCount = weekRoster.pitchers.filter((p) => !droppedThisWeek.has(p) && !pendingAdd.has(p)).length;
    html += `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${activePitCount}) <span class="wrs-group-pts">${fmt(Math.round(pitTotal * 100) / 100)} pts</span></div>`;

    const pitStatMap = {};
    allWeekPitching.forEach((p) => {
      pitStatMap[p.pitcher] = p;
    });

    const weekPitchingForTable = allWeekPitching.filter((p) => historicalPitchers.has(p.pitcher));
    const currentPitRoster = new Set(weekRoster.pitchers.filter((p) => !droppedThisWeek.has(p)));
    const allPitchersThisWeek = new Set([
      ...currentPitRoster,
      ...droppedPitchers,
      ...weekPitchingForTable
        .filter((p) => currentPitRoster.has(p.pitcher) || (p.weekly_score || 0) > 0)
        .map((p) => p.pitcher),
    ]);
    if (allPitchersThisWeek.size > 0) {
      html += '<div class="table-wrapper"><table class="data-table compact-table wrs-table"><thead><tr>';
      html +=
        '<th>Player</th><th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th>';
      html += '</tr></thead><tbody>';
      // Swap-chain ordering, same as the batter table above.
      const pitScoreByPlayer = {};
      allPitchersThisWeek.forEach((p) => (pitScoreByPlayer[p] = (pitStatMap[p] || {}).weekly_score || 0));
      orderWithSwapChains([...allPitchersThisWeek], pitScoreByPlayer, approvedSwaps, managerName).forEach((pitcher) => {
        const s = pitStatMap[pitcher] || {};
        const isScheduled = pendingAdd.has(pitcher);
        const onRoster = !isScheduled && weekRoster.pitchers.includes(pitcher) && !droppedThisWeek.has(pitcher);
        const wkRank = weekRanks.pitRanks[pitcher];
        const { pitCum, periodRankings: pRankingsPit } = getRoundData(round, week);
        const cumScore = pitCum[pitcher] || 0;
        const cumRank = pRankingsPit.pitRanks[pitcher];
        html += `<tr${isScheduled ? ' class="wrs-sched-row"' : onRoster ? '' : ' class="wrs-hist-row"'}>`;
        const pitTag =
          isScheduled || onRoster
            ? playerDateTag(pitcher, weekKey, weekIdx)
            : notRosteredTag(pitcher, 'pitchers', round);
        html += `<td>${displayPlayer(pitcher, seasonData)}${pitTag}</td>`;
        const ps = getEffPitStats(pitcher) || s;
        html += pitStatCell(s, 'gs', ps.gs || 0);
        html += pitStatCell(s, 'w', ps.w || 0);
        html += pitStatCell(s, 'qs', ps.qs != null ? fmtDec(ps.qs) : 0);
        html += pitStatCell(s, 'cg', ps.cg || 0);
        html += pitStatCell(s, 'cgso', ps.cgso || 0);
        html += pitStatCell(s, 'nh', ps.nh || 0);
        html += pitStatCell(s, 'ip', fmtDec(ps.ip || 0));
        html += pitStatCell(s, 'h', ps.h || 0);
        html += pitStatCell(s, 'er', ps.er || 0);
        html += pitStatCell(s, 'bb', ps.bb || 0);
        html += pitStatCell(s, 'k', ps.k || 0);
        html += `<td class="num"><strong>${fmt(s.weekly_score || 0)}</strong></td>`;
        html += `<td class="num rank-cell">${wkRank ? wkRank.rank + '/' + wkRank.total : '-'}</td>`;
        html += `<td class="num"><strong>${fmt(cumScore)}</strong></td>`;
        html += `<td class="num rank-cell">${cumRank ? cumRank.rank + '/' + cumRank.total : '-'}</td>`;
        html += '</tr>';
      });
      html += `</tbody><tfoot><tr class="wrs-subtotal-row">
        <td colspan="11"></td>
        <td class="wrs-subtotal-label">Pitching Total</td>
        <td class="num wrs-subtotal-val"><strong>${fmt(Math.round(pitTotal * 100) / 100)}</strong></td>
        <td colspan="3"></td>
      </tr></tfoot></table></div>`;
    } else {
      html += '<p class="text-muted" style="font-size:0.85rem;">No pitchers rostered this week.</p>';
    }

    // Week total footer
    html += `<div class="wrs-week-total">
      <span>Week Total</span>
      <span><strong>${fmt(weekTotal)}</strong></span>
    </div>`;

    html += '</div></div>'; // .wrs-body, .wrs-section

    weekHtml[weekKey] = html;
    weekTotals[weekKey] = weekTotal;
  });

  // ---- Assemble the grouped / nested layout ----
  // Pool Play nests two levels deep: Pool Play → Pool Play 1 / Pool Play 2 → each week.
  // Playoff rounds (QF/SF/Finals) render their weeks flat. Everything starts collapsed except
  // the branch that contains the current week (the current week's body is already open inside
  // weekHtml; here we open its ancestor groups so it's reachable).
  const pp1Weeks = weeksToShow.filter((wk) => wk.startsWith('PP1|'));
  const pp2Weeks = weeksToShow.filter((wk) => wk.startsWith('PP2|'));
  const playoffWeeks = weeksToShow.filter((wk) => !wk.startsWith('PP1|') && !wk.startsWith('PP2|'));

  const sumWeeks = (wks) => Math.round(wks.reduce((s, wk) => s + (weekTotals[wk] || 0), 0) * 100) / 100;

  // A collapsible group wrapper. Reuses the .wrs-header/.wrs-body markup (and toggleWeeklyScoring)
  // so the arrow, open state, and styling match the week sections.
  function wrsGroup(id, label, pts, open, extraClass, innerHtml) {
    const openCls = open ? ' wrs-open' : '';
    const disp = open ? 'block' : 'none';
    const ptsHtml = pts > 0 ? `${fmt(pts)} PTS` : '';
    return `<div class="wrs-section wrs-group ${extraClass}">
      <div class="wrs-header wrs-group-header${openCls}" onclick="toggleWeeklyScoring('${id}')">
        <span class="wrs-header-label">${label}</span>
        <span class="wrs-header-pts">${ptsHtml}</span>
      </div>
      <div class="wrs-body" id="wrs-body-${id}" style="display:${disp};">${innerHtml}</div>
    </div>`;
  }

  let out = '';

  const poolWeeks = pp1Weeks.concat(pp2Weeks);
  if (poolWeeks.length > 0) {
    let poolInner = '';
    if (pp1Weeks.length > 0) {
      const inner = pp1Weeks.map((wk) => weekHtml[wk]).join('');
      poolInner += wrsGroup(
        'grp_pp1',
        'Pool Play 1',
        sumWeeks(pp1Weeks),
        pp1Weeks.includes(currentWeekKey),
        'wrs-group-l2',
        inner
      );
    }
    if (pp2Weeks.length > 0) {
      const inner = pp2Weeks.map((wk) => weekHtml[wk]).join('');
      poolInner += wrsGroup(
        'grp_pp2',
        'Pool Play 2',
        sumWeeks(pp2Weeks),
        pp2Weeks.includes(currentWeekKey),
        'wrs-group-l2',
        inner
      );
    }
    out += wrsGroup(
      'grp_pool',
      'Pool Play',
      sumWeeks(poolWeeks),
      poolWeeks.includes(currentWeekKey),
      'wrs-group-l1',
      poolInner
    );
  }

  // Playoff weeks render flat; each week's open/collapsed state is already baked into weekHtml.
  playoffWeeks.forEach((wk) => {
    out += weekHtml[wk];
  });

  return out;
}

// Compute per-scoring-period totals for a manager
// Compute per-period batting/pitching/total for a manager's score boxes.
// Uses the same filtering logic as buildTeamStatsBreakdown so the numbers
// always agree with what the Team Stats tab shows.
function computeRosterPeriodScores(managerName, seasonData) {
  const result = {};

  if (DATA && DATA.team_weekly) {
    // Historical season — use pre-computed team_weekly
    const entries = DATA.team_weekly.filter((t) => t.manager === managerName);
    const roundMap = {};
    entries.forEach((t) => {
      if (!roundMap[t.round]) roundMap[t.round] = { batting: 0, pitching: 0, total: 0 };
      roundMap[t.round].batting += t.weekly_batting || 0;
      roundMap[t.round].pitching += t.weekly_pitching || 0;
    });
    for (const [round, data] of Object.entries(roundMap)) {
      data.batting = Math.round(data.batting * 100) / 100;
      data.pitching = Math.round(data.pitching * 100) / 100;
      data.total = Math.round((data.batting + data.pitching) * 100) / 100;
      result[round] = data;
    }
    return result;
  }

  if (!seasonData || seasonData.status === 'completed') return result;

  // Active season — every per-period subtotal is the sum of the per-week
  // managerWeekSubtotal so the stat cards reconcile to the weekly PTS badges
  // shown in the listing.
  const battingRows = seasonData.weekly_batting || [];
  const pitchingRows = seasonData.weekly_pitching || [];

  BREAKDOWN_PERIODS.forEach((period) => {
    let batTotal = 0;
    let pitTotal = 0;
    SEASON_SCHEDULE.forEach((schedWeek, idx) => {
      if (schedWeek.round !== period.key) return;
      batTotal += managerWeekSubtotal(seasonData, managerName, schedWeek, idx, battingRows, 'batter', 'batters');
      pitTotal += managerWeekSubtotal(seasonData, managerName, schedWeek, idx, pitchingRows, 'pitcher', 'pitchers');
    });

    if (batTotal !== 0 || pitTotal !== 0) {
      result[period.key] = {
        batting: Math.round(batTotal * 100) / 100,
        pitching: Math.round(pitTotal * 100) / 100,
        total: Math.round((batTotal + pitTotal) * 100) / 100,
      };
    }
  });

  return result;
}

window.switchRosterTab = function (btn, tabKey) {
  document.querySelectorAll('.roster-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.roster-tab-content').forEach((c) => (c.style.display = 'none'));
  btn.classList.add('active');
  const target = document.getElementById('rtab-' + tabKey);
  if (target) target.style.display = 'block';
};

window.toggleWeeklyScoring = function (safeId) {
  const body = document.getElementById(`wrs-body-${safeId}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  const header = body.previousElementSibling;
  if (header) header.classList.toggle('wrs-open', !isOpen);
};

// ---- Team Stats Breakdown (accordion by scoring period) ----
const BREAKDOWN_PERIODS = [
  { key: 'PP1', label: 'Pool Play 1', weekRange: 'Weeks 1–5', colorClass: 'period-pp1' },
  { key: 'PP2', label: 'Pool Play 2', weekRange: 'Weeks 6–10', colorClass: 'period-pp2' },
  { key: 'QF', label: 'Quarterfinals', weekRange: 'Weeks 11–12', colorClass: 'period-qf' },
  { key: 'SF', label: 'Semifinals', weekRange: 'Weeks 13–14', colorClass: 'period-sf' },
  { key: 'Finals', label: 'Finals', weekRange: 'Weeks 15–17', colorClass: 'period-finals' },
];

function buildTeamStatsBreakdown(managerName, seasonData) {
  // Determine data source
  const isHistorical = !!(DATA && DATA.batting_weekly);
  const isActive = !!(seasonData && seasonData.status === 'active');
  if (!isHistorical && !isActive) return '';

  let html = `<div class="card team-stats-breakdown">
    <h2>Team Stats Breakdown</h2>
    <p class="text-muted" style="margin-bottom:1rem;">Performance by round and week</p>`;

  BREAKDOWN_PERIODS.forEach((period) => {
    // Aggregate weekly totals for this period
    const weekTotals = {}; // { 'Week 1': { batting: X, pitching: Y } }
    const batterPeriodTotals = {};
    const pitcherPeriodTotals = {};

    if (isHistorical) {
      (DATA.batting_weekly || [])
        .filter((e) => e.manager === managerName && e.round === period.key)
        .forEach((e) => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].batting += e.weekly_score || 0;
          batterPeriodTotals[e.batter] = (batterPeriodTotals[e.batter] || 0) + (e.weekly_score || 0);
        });
      (DATA.pitching_weekly || [])
        .filter((e) => e.manager === managerName && e.round === period.key)
        .forEach((e) => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].pitching += e.weekly_score || 0;
          pitcherPeriodTotals[e.pitcher] = (pitcherPeriodTotals[e.pitcher] || 0) + (e.weekly_score || 0);
        });
    } else if (isActive) {
      (seasonData.weekly_batting || [])
        .filter((e) => {
          if (e.round !== period.key) return false;
          if (e.manager !== managerName && e.manager !== null) return false;
          const weekKey = `${e.round}|${e.week}`;
          const weekRoster = (seasonData.rosters &&
            seasonData.rosters[managerName] &&
            seasonData.rosters[managerName][weekKey]) || { batters: [], pitchers: [] };
          const weekRosterDates =
            (seasonData.roster_dates &&
              seasonData.roster_dates[managerName] &&
              seasonData.roster_dates[managerName][weekKey]) ||
            {};
          return (
            weekRoster.batters.includes(e.batter) ||
            (!!weekRosterDates[e.batter] && !weekRoster.pitchers.includes(e.batter))
          );
        })
        .forEach((e) => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].batting += e.weekly_score || 0;
          batterPeriodTotals[e.batter] = (batterPeriodTotals[e.batter] || 0) + (e.weekly_score || 0);
        });
      (seasonData.weekly_pitching || [])
        .filter((e) => {
          if (e.round !== period.key) return false;
          if (e.manager !== managerName && e.manager !== null) return false;
          const weekKey = `${e.round}|${e.week}`;
          const weekRoster = (seasonData.rosters &&
            seasonData.rosters[managerName] &&
            seasonData.rosters[managerName][weekKey]) || { batters: [], pitchers: [] };
          const weekRosterDates =
            (seasonData.roster_dates &&
              seasonData.roster_dates[managerName] &&
              seasonData.roster_dates[managerName][weekKey]) ||
            {};
          return (
            weekRoster.pitchers.includes(e.pitcher) ||
            (!!weekRosterDates[e.pitcher] && !weekRoster.batters.includes(e.pitcher))
          );
        })
        .forEach((e) => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].pitching += e.weekly_score || 0;
          pitcherPeriodTotals[e.pitcher] = (pitcherPeriodTotals[e.pitcher] || 0) + (e.weekly_score || 0);
        });
    }

    const periodTotal = Object.values(weekTotals).reduce((s, w) => s + w.batting + w.pitching, 0);
    const hasPeriodData = Object.keys(weekTotals).length > 0;
    if (!hasPeriodData) return;

    // Sort weeks naturally
    const sortedWeeks = Object.keys(weekTotals).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, '')) || 0;
      const nb = parseInt(b.replace(/\D/g, '')) || 0;
      return na - nb;
    });

    // Sort players by points descending
    const sortedBatters = Object.entries(batterPeriodTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([name, pts]) => ({ name, pts: Math.round(pts * 100) / 100 }));
    const sortedPitchers = Object.entries(pitcherPeriodTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([name, pts]) => ({ name, pts: Math.round(pts * 100) / 100 }));

    const periodId = `period-body-${period.key}`;

    html += `<div class="period-section">
      <div class="period-header ${period.colorClass}" onclick="togglePeriodSection('${period.key}')">
        <span class="period-header-label">${period.label.toUpperCase()} (${period.weekRange})</span>
        <span class="period-header-pts">${fmt(Math.round(periodTotal * 100) / 100)} PTS</span>
      </div>
      <div class="period-body" id="${periodId}" style="display:none;">`;

    // Weekly Breakdown
    html += `<div class="period-weekly-section">
        <h4>Weekly Breakdown</h4>
        <div class="period-week-grid">`;
    sortedWeeks.forEach((week) => {
      const w = weekTotals[week];
      const weekTotal = Math.round((w.batting + w.pitching) * 100) / 100;
      html += `<div class="period-week-card">
            <div class="week-card-label">${week}</div>
            <div class="week-card-pts">${fmt(weekTotal)}</div>
            <div class="week-card-detail">Bat: ${fmt(Math.round(w.batting * 100) / 100)} | Pit: ${fmt(Math.round(w.pitching * 100) / 100)}</div>
          </div>`;
    });
    html += `</div></div>`;

    // Player Performance
    html += `<div class="period-players-section">
        <h4>Player Performance</h4>
        <div class="period-players-groups">`;

    // Batters
    if (sortedBatters.length > 0) {
      html += `<div class="period-player-group">
            <div class="period-player-group-header">BATTERS</div>`;
      sortedBatters.forEach(({ name, pts }) => {
        html += `<div class="period-player-row">
              <span class="period-player-name">${displayPlayer(name, seasonData)}</span>
              <span class="period-player-type">BAT</span>
              <span class="period-player-pts">${fmt(pts)}</span>
            </div>`;
      });
      html += `</div>`;
    }

    // Pitchers
    if (sortedPitchers.length > 0) {
      html += `<div class="period-player-group">
            <div class="period-player-group-header">PITCHERS</div>`;
      sortedPitchers.forEach(({ name, pts }) => {
        html += `<div class="period-player-row">
              <span class="period-player-name">${displayPlayer(name, seasonData)}</span>
              <span class="period-player-type">PIT</span>
              <span class="period-player-pts">${fmt(pts)}</span>
            </div>`;
      });
      html += `</div>`;
    }

    html += `</div></div>`; // .period-players-groups, .period-players-section

    html += `</div></div>`; // .period-body, .period-section
  });

  html += `</div>`; // .team-stats-breakdown
  return html;
}

window.togglePeriodSection = function (periodKey) {
  const body = document.getElementById(`period-body-${periodKey}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  const header = body.previousElementSibling;
  if (header) header.classList.toggle('period-open', !isOpen);
};

// ---- Player Swaps Section ----
const SWAP_REASONS = ['Free Swap (one per round)', 'IL Swap', 'Drop Swap', 'Trade Swap'];

// Outcome of the most recent swap submission ({ type: 'success'|'error', text }). The swap form is
// re-rendered after an auto-applied swap (and again when daily stats land), which rebuilds the
// #swap-form-success/-error elements — so the confirmation is baked into the form render from this
// variable instead of written to a DOM node a re-render would wipe. Cleared on the next submission.
let _swapFormNotice = null;
const COMMISSIONER_SWAP_REASONS = [...SWAP_REASONS, 'Commissioner Swap'];

function getSeasonSwaps(seasonData) {
  if (DATA && DATA.swaps) return DATA.swaps; // historical
  if (seasonData && seasonData.swaps) return seasonData.swaps; // active
  return [];
}

// Tomorrow (ET) as an ISO date — the earliest a manager may schedule a swap for, since only a
// date strictly after today schedules one (today means "apply now").
function tomorrowET() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return isoDateET(d);
}

// Last calendar day of a round — the latest a manager may schedule a swap for, since a new period
// starts fresh from its own submission. Client twin of the server's scheduleRoundEndDate.
function scheduleRoundEnd(seasonData, round) {
  const dates = (seasonData && seasonData.schedule_dates) || [];
  let end = null;
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    if (SEASON_SCHEDULE[i].round === round && dates[i] && dates[i].end) {
      if (!end || dates[i].end > end) end = dates[i].end;
    }
  }
  return end;
}

// Schedule week whose date window contains today (ET). During a gap between weeks (e.g. the
// All-Star break) or after the season it falls back to the latest started week; before the
// season starts, the first week.
function currentScheduleWeekKey() {
  const dates = getScheduleDates() || [];
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let idx = 0;
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const d = dates[i];
    if (!d || !d.start || todayET < d.start) continue;
    idx = i;
    if (d.end && todayET <= d.end) break;
  }
  return `${SEASON_SCHEDULE[idx].round}|${SEASON_SCHEDULE[idx].week}`;
}

// Container id for the My Roster copy of the swap log (manager-scoped).
const ROSTER_SWAP_LOG_ID = 'roster-swap-log';

function buildPlayerSwapsSection(managerName, isCommissioner, seasonData) {
  const isActive = !!(seasonData && seasonData.status === 'active');

  // Gather all swaps for this manager
  const allSwaps = getSeasonSwaps(seasonData);
  const emailMap = DATA && DATA.email_map ? DATA.email_map : {};

  // For active season swaps, filter by manager field; for historical, filter by email
  const mySwaps = allSwaps.filter((s) => {
    if (s.manager) return s.manager === managerName;
    return (emailMap[s.email] || s.email) === managerName;
  });

  const pendingCount = mySwaps.filter((s) => s.status === 'pending').length;
  const approvedCount = mySwaps.filter((s) => !s.status || s.status === 'approved').length;

  let html = `<div class="card player-swaps-section">
    <h2>Player Swaps</h2>
    <p class="text-muted" style="margin-bottom:1rem;">Request and track player transactions</p>`;

  // Stats cards
  html += `<div class="swap-stats-grid">
    <div class="swap-stat-card">
      <div class="swap-stat-num">${mySwaps.length}</div>
      <div class="swap-stat-label">Total Swaps</div>
    </div>
    <div class="swap-stat-card swap-stat-pending">
      <div class="swap-stat-num">${pendingCount}</div>
      <div class="swap-stat-label">Pending</div>
    </div>
    <div class="swap-stat-card swap-stat-approved">
      <div class="swap-stat-num">${approvedCount}</div>
      <div class="swap-stat-label">Approved</div>
    </div>
  </div>`;

  // Swap Request Form (active season only)
  if (isActive) {
    // Use per-week roster model - get union of all weeks for this manager
    const roster = getAllRosteredPlayers(seasonData, managerName);

    // Build available (non-rostered) players from pool.
    // roster_dates add/drop windows are the source of truth (rosterStatusForManager); the per-week
    // roster arrays are a derived cache and are only a fallback, scoped to this period's weeks.
    // backfillRosterDatesFromSwaps is called before this so old approved swaps
    // also get their drop_dates populated.
    const swapTodayET = isoDateET(new Date());

    // The period the swap belongs to. Uses the same round detection as the rest of the swap form
    // (and as the server, which stamps the round on submission) so that in a gap between rounds —
    // e.g. after the QF has ended while SF lineups are going in — availability is judged against
    // the round the swap is actually charged to, not the one that just finished.
    const swapCurRound = getCurrentScheduleRound(seasonData).round;

    // A new submission period (PP2/QF/SF/Finals) starts fresh from its own submission, so
    // "currently rostered" must only consider this period's adds/drops; null for PP1 leaves that
    // period unchanged. The array fallback is period-scoped for the same reason: a manager
    // eliminated in an earlier round still has that round's roster array on file, and reading it
    // would keep their old players out of the available pool for everyone still playing.
    const curPeriodStart = periodStartForSeason(seasonData, swapCurRound);
    const curPeriodWks = periodWeekKeys(swapCurRound, SEASON_SCHEDULE);

    const swapRosterStatus = (mgr, player) =>
      rosterStatusForManager(player, {
        rosterDates: (seasonData.roster_dates || {})[mgr],
        rosters: (seasonData.rosters || {})[mgr],
        periodStart: curPeriodStart,
        asOf: swapTodayET,
        weekKeys: curPeriodWks,
      });

    // Returns true if `player` is on THIS manager's roster TODAY. Evaluating as of today keeps a
    // scheduled swap from taking effect early in this list: the outgoing player stays selectable
    // until their drop date, and an incoming player isn't offered until their add date lands.
    const isStillActiveForMgr = (player) => swapRosterStatus(managerName, player) === 'active';

    // Filter to currently active players only so previously dropped players
    // don't appear in the Player Out list.
    const currentBatters = roster.batters.filter(isStillActiveForMgr);
    const currentPitchers = roster.pitchers.filter(isStillActiveForMgr);

    // Managers come from the canonical commissioner list (db.managers); roster-data keys are
    // unioned in so a name present only in rosters/roster_dates can still hold a player.
    const swapMgrNames = Array.from(
      new Set([
        ...getManagers().map((m) => m.name),
        ...Object.keys(seasonData.rosters || {}),
        ...Object.keys(seasonData.roster_dates || {}),
      ])
    );

    // A player is unavailable only while some manager holds them RIGHT NOW: on a roster today
    // ('active'), or already claimed by a scheduled swap whose add date hasn't landed yet
    // ('scheduled') — taking them would collide when that swap takes effect.
    const isCurrentlyTaken = (player) =>
      swapMgrNames.some((mgr) => {
        const st = swapRosterStatus(mgr, player);
        return st === 'active' || st === 'scheduled';
      });
    const availBatters = (seasonData.batters_pool || []).filter((b) => !isCurrentlyTaken(b)).sort();
    const availPitchers = (seasonData.pitchers_pool || []).filter((p) => !isCurrentlyTaken(p)).sort();

    // Effective-date field: prefilled with the date the swap WOULD take effect if submitted
    // as-is (the auto path — today, bumped to tomorrow once a selected player's team has
    // started; refreshSwapAutoEffectiveDate keeps it live as players are picked). Today always
    // means "apply now" and is always accepted — the players' teams' game start times, not the
    // calendar, decide whether that lands today or tomorrow. Only a date STRICTLY AFTER today
    // schedules the swap, and managers may only schedule FORWARD (no backdating) and no further
    // than the end of the current round (the server enforces both; period boundaries start fresh
    // from a new submission, so scheduling across one is invalid).
    const _swapEffToday = isoDateET(new Date());
    const _swapEffMax = scheduleRoundEnd(seasonData, getCurrentScheduleRound(seasonData).round);

    html += `<div class="swap-form-card">
      <h3>Make a Swap</h3>
      <p class="text-muted" style="margin-bottom:0.75rem;">Swaps take effect immediately when submitted. If either player's team has already started playing today, the swap becomes effective tomorrow. You can also schedule the swap for a future date. Swap limits and IL status are checked automatically.</p>
      <div class="swap-form-grid">
        <div class="swap-form-field" style="grid-column:1 / -1;">
          <label>Player Type</label>
          <div class="swap-type-toggle">
            <button class="btn btn-sm swap-type-btn active" id="swap-type-batter" onclick="swapTypeToggle('batter')">Batter</button>
            <button class="btn btn-sm swap-type-btn" id="swap-type-pitcher" onclick="swapTypeToggle('pitcher')">Pitcher</button>
          </div>
        </div>
        <div class="swap-form-field">
          <label for="swap-player-out">Player Out (from your roster)</label>
          <select id="swap-player-out" class="form-select" onchange="refreshSwapAutoEffectiveDate()">
            <option value="">Select player to swap out...</option>
            ${currentBatters
              .sort()
              .map((b) => `<option value="${b}" data-type="batter">${displayPlayer(b, seasonData)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-player-in-search">Player In (available)</label>
          <div class="player-search-container">
            <input type="text" id="swap-player-in-search" class="form-input" placeholder="Type to search available players..." autocomplete="off">
            <div id="swap-player-in-results" class="player-search-results"></div>
          </div>
          <input type="hidden" id="swap-player-in" value="">
        </div>
        <div class="swap-form-field">
          <label for="swap-reason">Transaction Reason</label>
          <select id="swap-reason" class="form-select">
            <option value="">Select reason...</option>
            ${SWAP_REASONS.map((r) => `<option value="${r}">${swapReasonLabel(r)}</option>`).join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-effective-date">Effective Date</label>
          <input type="date" id="swap-effective-date" class="form-input" value="${_swapEffToday}" data-auto-date="${_swapEffToday}" min="${_swapEffToday}"${_swapEffMax ? ` max="${_swapEffMax}"` : ''}>
          <small class="text-muted" style="font-size:0.75rem;">Shows when the swap will take effect — today applies it now (tomorrow instead if a game has already started), or pick a later date to schedule it.</small>
        </div>
      </div>
      <div style="margin-top:0.75rem;">
        <button class="btn btn-primary" onclick="submitSwapRequest('${jsStr(managerName)}', event)">Submit Swap</button>
      </div>
      <p id="swap-form-error" class="error-text" style="display:${_swapFormNotice && _swapFormNotice.type === 'error' ? 'block' : 'none'};margin-top:0.5rem;">${_swapFormNotice && _swapFormNotice.type === 'error' ? esc(_swapFormNotice.text) : ''}</p>
      <p id="swap-form-success" class="success-text" style="display:${_swapFormNotice && _swapFormNotice.type === 'success' ? 'block' : 'none'};margin-top:0.5rem;">${_swapFormNotice && _swapFormNotice.type === 'success' ? esc(_swapFormNotice.text) : ''}</p>
    </div>`;

    // Store roster data as data attributes for the type toggle to use
    html += `<script type="application/json" id="swap-roster-data">${JSON.stringify({
      batters: currentBatters.sort(),
      pitchers: currentPitchers.sort(),
      availBatters: availBatters,
      availPitchers: availPitchers,
      battersTeam: seasonData.batters_team || {},
      pitchersTeam: seasonData.pitchers_team || {},
    })}</script>`;
  }

  // Commissioner: pending swaps for THIS manager only
  if (isCommissioner && isActive) {
    const pendingSwaps = mySwaps.filter((s) => s.status === 'pending');
    if (pendingSwaps.length > 0) {
      const _today = new Date().toISOString().split('T')[0];
      const _tomorrow = (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return d.toISOString().split('T')[0];
      })();
      html += `<div class="swap-pending-card">
        <h3>Pending Swap Approvals</h3>`;
      pendingSwaps.forEach((s) => {
        html += `<div class="swap-pending-item" id="swap-item-${s.id}">
          <div class="swap-pending-header">
            <strong>${esc(s.manager)}</strong>
            <span class="swap-badge swap-badge-pending">Pending</span>
          </div>
          <div class="swap-pending-details">
            <span>${displayPlayer(s.player_out, seasonData)} &rarr; ${displayPlayer(s.player_in, seasonData)}</span>
            <span class="swap-detail-reason">${esc(s.reason)}</span>
            <span class="swap-detail-date">${s.swap_date || ''}</span>
          </div>
          <div class="swap-effective-dates">
            <span class="swap-effective-label">Swap Effective Date</span>
            <div class="swap-date-fields">
              <div class="swap-date-field">
                <label>Drop Date (${esc(s.player_out)})</label>
                <input type="date" id="swap-drop-date-${s.id}" class="form-input swap-date-input" value="${s.drop_date || _today}"
                  onchange="syncSwapAddDate('swap-drop-date-${s.id}','swap-add-date-${s.id}')">
              </div>
              <div class="swap-date-field">
                <label>Add Date (${esc(s.player_in)})</label>
                <input type="date" id="swap-add-date-${s.id}" class="form-input swap-date-input" value="${s.add_date || _tomorrow}">
              </div>
            </div>
          </div>
          <div class="swap-pending-actions" id="swap-actions-${s.id}">
            <button class="btn btn-sm btn-success" onclick="approveSwap('${s.id}')">Approve</button>
            <button class="btn btn-sm btn-secondary" onclick="editSwapInline('${s.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="denySwap('${s.id}')">Deny</button>
          </div>
          <div class="swap-edit-form" id="swap-edit-${s.id}" style="display:none;"></div>
        </div>`;
      });
      html += `</div>`;
    }
  }

  // Commissioner: Roster management (Add/Drop/Edit) per week
  if (isCommissioner && isActive) {
    const safeMgr = jsStr(managerName);

    html += `<div class="card" style="margin-top:1rem;">
      <h3>Commissioner Roster Management</h3>
      <p class="text-muted" style="margin-bottom:0.75rem;">Add/drop players and edit stats for ${esc(managerName)}</p>`;

    // Week selector. This HTML is built while the PREVIOUS render's DOM is still live
    // (the container's innerHTML is replaced afterward), so read the old select to preserve
    // the week the commissioner was viewing across re-renders (45s auto-poll, post-action
    // refreshes). First render defaults to the CURRENT week — not Week 1.
    const prevWeekEl = document.getElementById('comm-roster-week');
    const prevWeek = prevWeekEl ? prevWeekEl.value : '';
    const selectedWeek = SEASON_SCHEDULE.some((s) => `${s.round}|${s.week}` === prevWeek)
      ? prevWeek
      : currentScheduleWeekKey();
    html += `<div class="form-row" style="margin-bottom:0.75rem;">
      <label class="upload-label">Week</label>
      <select id="comm-roster-week" class="form-select" style="max-width:280px;" onchange="updateCommRosterWeekView('${safeMgr}')">`;
    SEASON_SCHEDULE.forEach((s) => {
      const wk = `${s.round}|${s.week}`;
      html += `<option value="${wk}"${wk === selectedWeek ? ' selected' : ''}>${s.label}</option>`;
    });
    html += `</select></div>`;

    // Batters stats table (populated dynamically)
    html += `<div id="comm-roster-batters"></div>`;
    html += `<div class="roster-add-row player-search-container" style="margin-top:0.5rem;">
      <input type="text" id="comm-add-bat" class="form-input player-search-input" placeholder="Type to search batters..." autocomplete="off" data-pool-type="batters" data-week-key="" data-manager="${safeMgr}">
      <div class="player-search-results" id="results-comm-add-bat"></div>
      <button class="btn btn-sm btn-primary" onclick="commAddPlayer('${safeMgr}','batters')">Add</button>
    </div>`;

    // Pitchers stats table (populated dynamically)
    html += `<div id="comm-roster-pitchers"></div>`;
    html += `<div class="roster-add-row player-search-container" style="margin-top:0.5rem;">
      <input type="text" id="comm-add-pit" class="form-input player-search-input" placeholder="Type to search pitchers..." autocomplete="off" data-pool-type="pitchers" data-week-key="" data-manager="${safeMgr}">
      <div class="player-search-results" id="results-comm-add-pit"></div>
      <button class="btn btn-sm btn-primary" onclick="commAddPlayer('${safeMgr}','pitchers')">Add</button>
    </div>`;

    // Week total (populated dynamically)
    html += `<div id="comm-roster-total"></div>`;

    html += `</div>`;
  }

  // All Swaps — the same click-to-expand log as the league-wide Swap Log tab, scoped to this
  // manager. Populated by renderSwapLog(ROSTER_SWAP_LOG_ID, ...) once the container is in the DOM
  // (renderRosterData does it right after setting innerHTML).
  html += `<div class="swap-list-section">
    <h3>All Swaps</h3>
    <p class="text-muted" style="margin-bottom:0.75rem;">Click any swap to see its full details.</p>
    <div id="${ROSTER_SWAP_LOG_ID}"></div>
  </div>`;

  // ---- Initial Player Submission ----
  if (isActive) {
    const safeMgr = jsStr(managerName);
    const submission = seasonData.initial_submissions && seasonData.initial_submissions[managerName];
    const isApproved = submission && submission.status === 'approved';
    const isPending = submission && submission.status === 'pending';
    const submittedBatters = submission ? submission.batters || [] : [];
    const submittedPitchers = submission ? submission.pitchers || [] : [];

    const poolBatCount = (seasonData.batters_pool || []).length;
    const poolPitCount = (seasonData.pitchers_pool || []).length;
    const poolReady = poolBatCount > 0 && poolPitCount > 0;

    // Same late mode as the playoff periods: PP1 closes at its own first pitch, and a manager who
    // misses opening day still drafts — his roster just starts on the next day he can't already
    // have watched. See buildLateSubmissionBanner.
    const pp1Late = !isApproved && poolReady && periodIsLate('pp1') && periodStillRunning('pp1', submission);

    html += `<div class="card initial-submission-section" id="period-submission-card-pp1" style="margin-top:1rem;">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
        <span class="swap-badge" style="background:var(--primary);color:#fff;font-size:0.8rem;">Pool Play 1</span>
        <h3 style="margin:0;">Player Submission</h3>
      </div>
      <p class="text-muted" style="margin-bottom:0.75rem;">Submit your roster for Pool Play 1: 4 batters and 3 pitchers</p>`;

    if (!poolReady && !isApproved) {
      html += `<div style="padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);margin-bottom:0.75rem;">
        <p class="text-muted" style="font-size:0.85rem;margin:0;">The player pool has not been uploaded yet. Please wait for the commissioner to upload the initial player pool files before selecting your roster. If you expect it to be ready, <a href="#" onclick="location.reload();return false;">refresh the page</a>.</p>
      </div>`;
    } else if (poolReady && !isApproved) {
      html += `<p class="text-muted" style="font-size:0.82rem;margin-bottom:0.75rem;">Player pool available: ${poolBatCount} batters, ${poolPitCount} pitchers</p>`;
    }

    if (isApproved) {
      // Show approved roster (read-only)
      html += `<div class="swap-badge swap-badge-approved" style="margin-bottom:0.75rem;">Approved by Commissioner</div>`;
      html += `<div class="wrs-group-label">BATTERS (${submittedBatters.length}/4)</div>`;
      html += '<div class="comm-player-list">';
      submittedBatters.forEach((b) => {
        html += `<div class="comm-player-item"><span>${displayPlayer(b, seasonData)}</span></div>`;
      });
      html += '</div>';
      html += `<div class="wrs-group-label" style="margin-top:0.5rem;">PITCHERS (${submittedPitchers.length}/3)</div>`;
      html += '<div class="comm-player-list">';
      submittedPitchers.forEach((p) => {
        html += `<div class="comm-player-item"><span>${displayPlayer(p, seasonData)}</span></div>`;
      });
      html += '</div>';

      // Allow editing if the PP1 deadline hasn't passed (or isn't configured yet)
      if (isPeriodTimeOpen(seasonData, 'pp1')) {
        const pp1Deadline = getPeriodDeadline(seasonData, 'pp1');
        const deadlineNote = pp1Deadline
          ? `Editing available until <strong>${pp1Deadline.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</strong>. Re-editing requires commissioner re-approval.`
          : 'Re-editing will require commissioner re-approval. Set a deadline in Season Setup to lock submissions before the first game.';
        html += `<div style="margin-top:1rem;padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
          <button class="btn btn-secondary" onclick="editApprovedPeriodSubmission('pp1','${safeMgr}')">Edit Submission</button>
          <p class="text-muted" style="margin-top:0.5rem;margin-bottom:0;font-size:0.82rem;">${deadlineNote}</p>
        </div>`;
      }
    } else if (poolReady && !isPeriodTimeOpen(seasonData, 'pp1') && !pp1Late) {
      // Window not yet open, or already closed (PP1 has begun) — no editable form, no submit.
      // Mirrors the playoff-period cards so stray PP1 submissions can't land mid-season.
      const pp1OpenDate = getPeriodOpenDate(seasonData, 'pp1');
      const pp1Deadline = getPeriodDeadline(seasonData, 'pp1');
      if (pp1OpenDate && Date.now() < pp1OpenDate.getTime()) {
        const openStr = pp1OpenDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        html += `<div style="padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
          <p class="text-muted" style="font-size:0.85rem;margin:0;">Submission window opens <strong>${openStr}</strong>${
            pp1Deadline
              ? ` and closes at <strong>${pp1Deadline.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</strong>`
              : ''
          }.</p>
        </div>`;
      } else {
        html += `<p class="text-muted" style="font-size:0.85rem;">Submission window has closed.</p>`;
      }
    } else if (poolReady) {
      // Editable submission form (only when pool is available and the window is open — or when it
      // has closed and this manager is submitting late)
      if (pp1Late) html += buildLateSubmissionBanner('pp1', 'Pool Play 1', submission);
      if (isPending) {
        html += `<div class="swap-badge swap-badge-pending" style="margin-bottom:0.75rem;">Pending Commissioner Approval</div>`;
      }

      // Batters
      html += `<div class="wrs-group-label">BATTERS (${submittedBatters.length}/4)</div>`;
      html += `<div id="initial-sub-batters">`;
      if (submittedBatters.length > 0) {
        html += '<div class="comm-player-list">';
        submittedBatters.forEach((b) => {
          const safeB = jsStr(b);
          html += `<div class="comm-player-item">
            <span>${displayPlayer(b, seasonData)}</span>
            <button class="btn btn-sm btn-danger" onclick="removeInitialPlayer('${safeMgr}','batters','${safeB}')">Remove</button>
          </div>`;
        });
        html += '</div>';
      }
      html += '</div>';
      if (submittedBatters.length < 4) {
        html += `<div class="roster-add-row player-search-container" style="margin-top:0.5rem;">
          <input type="text" id="initial-add-bat" class="form-input player-search-input" placeholder="Type to search batters..." autocomplete="off" data-pool-type="batters" data-week-key="initial" data-manager="${safeMgr}">
          <div class="player-search-results" id="results-initial-add-bat"></div>
          <button class="btn btn-sm btn-primary" onclick="addInitialPlayer('${safeMgr}','batters')">Add</button>
        </div>`;
      }

      // Pitchers
      html += `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${submittedPitchers.length}/3)</div>`;
      html += `<div id="initial-sub-pitchers">`;
      if (submittedPitchers.length > 0) {
        html += '<div class="comm-player-list">';
        submittedPitchers.forEach((p) => {
          const safeP = jsStr(p);
          html += `<div class="comm-player-item">
            <span>${displayPlayer(p, seasonData)}</span>
            <button class="btn btn-sm btn-danger" onclick="removeInitialPlayer('${safeMgr}','pitchers','${safeP}')">Remove</button>
          </div>`;
        });
        html += '</div>';
      }
      html += '</div>';
      if (submittedPitchers.length < 3) {
        html += `<div class="roster-add-row player-search-container" style="margin-top:0.5rem;">
          <input type="text" id="initial-add-pit" class="form-input player-search-input" placeholder="Type to search pitchers..." autocomplete="off" data-pool-type="pitchers" data-week-key="initial" data-manager="${safeMgr}">
          <div class="player-search-results" id="results-initial-add-pit"></div>
          <button class="btn btn-sm btn-primary" onclick="addInitialPlayer('${safeMgr}','pitchers')">Add</button>
        </div>`;
      }

      // Submit button
      if (pp1Late) {
        html += buildLateSubmissionControls(
          'pp1',
          'Pool Play 1',
          managerName,
          submittedBatters,
          submittedPitchers,
          submission
        );
      } else if (!isPending) {
        const allSelected = submittedBatters.length === 4 && submittedPitchers.length === 3;
        const missingBatters = 4 - submittedBatters.length;
        const missingPitchers = 3 - submittedPitchers.length;
        const parts = [];
        if (missingBatters > 0) parts.push(`${missingBatters} batter${missingBatters > 1 ? 's' : ''}`);
        if (missingPitchers > 0) parts.push(`${missingPitchers} pitcher${missingPitchers > 1 ? 's' : ''}`);
        const hint = allSelected ? '' : `Still need: ${parts.join(' and ')}.`;
        html += `<div style="margin-top:1rem;">
          <button class="btn btn-primary"${allSelected ? `` : ` disabled style="opacity:0.45;cursor:not-allowed;"`} onclick="${allSelected ? `submitInitialRoster('${safeMgr}')` : ''}">Submit for Approval</button>
          <p class="text-muted" style="margin-top:0.5rem;font-size:0.82rem;">${allSelected ? 'All players selected — ready to submit.' : `Select all 4 batters and 3 pitchers before submitting. ${hint}`}</p>
        </div>`;
      } else if (isPending) {
        html += `<p class="text-muted" style="margin-top:0.75rem;font-size:0.82rem;">You can still modify your roster until the commissioner approves it.</p>`;
      }
    }

    // Commissioner approval section
    if (isCommissioner && isActive) {
      const allSubs = seasonData.initial_submissions || {};
      const allManagers = getManagers();
      const pendingSubs = allManagers.filter((m) => {
        const sub = allSubs[m.name];
        return sub && sub.status === 'pending';
      });

      if (pendingSubs.length > 0) {
        html += `<div class="swap-pending-card" style="margin-top:1rem;">
          <h4>Pending Initial Roster Approvals</h4>`;
        pendingSubs.forEach((m) => {
          const sub = allSubs[m.name];
          const safeName = jsStr(m.name);
          html += `<div class="swap-pending-item" id="initial-sub-${m.name.replace(/\s+/g, '-')}">
            <div class="swap-pending-header">
              <strong>${esc(m.name)}</strong>
              <span class="swap-badge swap-badge-pending">Pending</span>
            </div>
            <div style="padding:0.5rem 0;">
              <div style="font-size:0.82rem;"><strong>Batters:</strong> ${(sub.batters || []).join(', ') || 'None'}</div>
              <div style="font-size:0.82rem;"><strong>Pitchers:</strong> ${(sub.pitchers || []).join(', ') || 'None'}</div>
            </div>
            <div id="initial-edit-${m.name.replace(/\s+/g, '-')}" style="display:none;"></div>
            ${buildForgivenessControls('pp1', m.name, sub)}
            <div class="swap-pending-actions">
              <button class="btn btn-sm btn-success" onclick="approveInitialSubmission('${safeName}')">Approve</button>
              <button class="btn btn-sm btn-secondary" onclick="editInitialSubmission('${safeName}')">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="denyInitialSubmission('${safeName}')">Deny</button>
            </div>
          </div>`;
        });
        html += `</div>`;
      }
    }

    html += `</div>`; // .initial-submission-section

    // ---- PP2 / Playoff Period Submission Cards ----
    // The card is titled for the manager it is being rendered for, which only matters in the
    // Finals period: two of its four submitters are playing the 3rd-place game, not the Finals.
    const periodOrder = [
      { period: 'pp2', qualCheck: true },
      { period: 'qf', qualCheck: true },
      { period: 'sf', qualCheck: true },
      { period: 'finals', qualCheck: true },
    ];
    for (const { period } of periodOrder) {
      const label = submissionPeriodLabel(seasonData, period, managerName);
      const openDate = getPeriodOpenDate(seasonData, period);
      const deadline = getPeriodDeadline(seasonData, period);
      const qualified = isManagerQualifiedForPeriod(managerName, period, seasonData);
      const hasDeadline = !!deadline;

      // Only show if the window has opened OR will open soon (within PP1 for pp2, etc.)
      // For non-open windows with no configured deadline, skip entirely
      const windowHasOpened = !openDate || Date.now() >= openDate.getTime();
      if (!windowHasOpened && !hasDeadline) continue;
      if (!windowHasOpened && !qualified) continue;

      html += buildPeriodSubmissionCard(period, label, managerName, isCommissioner, seasonData);
    }
  }

  html += '</div>'; // .player-swaps-section
  return html;
}

// ---- Late submission UI ----
//
// A manager who misses a period's lock keeps his form. What changes is the date his roster
// starts on, and that has to be said plainly on the card before he picks anyone — the difference
// between a roster that counts from Monday and one that counts from Wednesday is most of the
// round. Two paths from here:
//
//   Submit  — take the automatic next-viable date and get on with it. Still goes to the
//             commissioner for the same approval every roster gets.
//   Beg     — ask the commissioner to back-date it instead. The roster is filed with NO effective
//             date; the commissioner names one when he rules.
//
// Both render only when the SERVER says the period is late (see SUBMISSION_WINDOWS).

// The explanation box. Shown at the top of a late period's form, in whatever state the manager
// has already left it.
function buildLateSubmissionBanner(period, periodLabel, sub) {
  const state = submissionLateState(sub);
  const win = SUBMISSION_WINDOWS[period] || {};
  const auto = periodEffectiveDate(period);
  const lockStr = win.lock_at
    ? new Date(win.lock_at).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : null;

  if (state.forgivenessPending) {
    return `<div style="padding:0.75rem;background:#e7f1ff;border-radius:6px;border:1px solid #6ea8fe;margin-bottom:0.75rem;">
      <p style="font-size:0.9rem;margin:0 0 0.35rem;color:#084298;font-weight:600;">Your plea is with the commissioner</p>
      <p style="font-size:0.82rem;margin:0;color:#084298;">He decides which day your ${esc(periodLabel)} roster starts on. If he says no, it still counts &mdash; from ${esc(fmtEffectiveDate(state.autoEffectiveDate) || 'the next viable day')}.</p>
      ${state.reason ? `<p style="font-size:0.8rem;margin:0.5rem 0 0;color:#084298;font-style:italic;">&ldquo;${esc(state.reason)}&rdquo;</p>` : ''}
    </div>`;
  }

  const verdict =
    state.forgiveness === 'granted' && state.effectiveDate
      ? `The commissioner back-dated it to <strong>${esc(fmtEffectiveDate(state.effectiveDate))}</strong>.`
      : state.forgiveness === 'denied'
        ? `The commissioner denied the back-date, so it counts from <strong>${esc(fmtEffectiveDate(state.effectiveDate) || 'the next viable day')}</strong>.`
        : auto
          ? `Anything you submit now counts from <strong>${esc(fmtEffectiveDate(auto))}</strong> &mdash; you cannot pick up points from a day that has already been played.`
          : `The ${esc(periodLabel)} period is over, so there is no day left for a new roster to start on. Only the commissioner can still back-date one.`;

  return `<div style="padding:0.75rem;background:#fff3cd;border-radius:6px;border:1px solid #ffc107;margin-bottom:0.75rem;">
    <p style="font-size:0.9rem;margin:0 0 0.35rem;color:#856404;font-weight:600;">You missed the ${esc(periodLabel)} roster deadline${lockStr ? ` (${esc(lockStr)})` : ''}</p>
    <p style="font-size:0.82rem;margin:0;color:#856404;">${verdict}</p>
  </div>`;
}

// The Submit / Beg controls that replace the ordinary "Submit for Approval" button on a late
// period. `sub` may be undefined — a manager who never started a roster is the common case here.
function buildLateSubmissionControls(period, periodLabel, managerName, batters, pitchers, sub) {
  const safeMgr = jsStr(managerName);
  const state = submissionLateState(sub);
  const status = (sub && sub.status) || 'draft';
  const auto = periodEffectiveDate(period);

  if (status === 'pending') {
    const line = state.forgivenessPending
      ? 'Waiting on the commissioner to rule on your plea and set the date.'
      : `Waiting on commissioner approval. It counts from <strong>${esc(fmtEffectiveDate(state.effectiveDate) || 'the next viable day')}</strong>.`;
    return `<div style="margin-top:1rem;padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
      <p class="text-muted" style="font-size:0.82rem;margin:0;">${line}</p>
    </div>`;
  }

  const rosterComplete = (batters || []).length === 4 && (pitchers || []).length === 3;
  const actions = lateSubmissionActions({
    isLate: true,
    hasApproved: status === 'approved',
    forgiveness: state.forgiveness,
    effectiveDate: auto,
    rosterComplete,
  });

  const missing = [];
  if ((batters || []).length < 4) missing.push(`${4 - batters.length} batter${batters.length < 3 ? 's' : ''}`);
  if ((pitchers || []).length < 3) missing.push(`${3 - pitchers.length} pitcher${pitchers.length < 2 ? 's' : ''}`);

  const dead = ' disabled style="opacity:0.45;cursor:not-allowed;"';
  const submitLabel = auto ? `Submit &mdash; starts ${esc(fmtEffectiveDate(auto))}` : 'Submit';
  const pleaId = `late-plea-${period}`;

  let html = `<div style="margin-top:1rem;display:flex;flex-wrap:wrap;gap:0.5rem;">
    <button class="btn btn-primary"${actions.canSubmit ? '' : dead} onclick="${actions.canSubmit ? `submitLateRoster('${period}','${safeMgr}')` : ''}">${submitLabel}</button>
    <button class="btn btn-secondary"${actions.canBeg ? '' : dead} onclick="${actions.canBeg ? `toggleForgivenessForm('${period}')` : ''}">Beg Commish for Forgiveness</button>
  </div>`;

  if (!rosterComplete) {
    html += `<p class="text-muted" style="margin-top:0.5rem;font-size:0.82rem;">Still need: ${missing.join(' and ')}.</p>`;
  } else if (!actions.canSubmit && actions.reason === 'period_over') {
    html += `<p class="text-muted" style="margin-top:0.5rem;font-size:0.82rem;">No day is left in ${esc(periodLabel)} for a roster to start on &mdash; begging is your only option.</p>`;
  } else {
    html += `<p class="text-muted" style="margin-top:0.5rem;font-size:0.82rem;">Submitting takes the automatic date. Begging sends it to the commissioner instead, and he chooses which day it counts from.</p>`;
  }

  html += `<div id="${pleaId}" style="display:none;margin-top:0.75rem;padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
    <label for="${pleaId}-text" style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.35rem;">Why should the commissioner back-date your roster?</label>
    <textarea id="${pleaId}-text" class="form-input" rows="3" style="width:100%;" placeholder="Make your case. The commissioner sees this, and so does Slack."></textarea>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
      <button class="btn btn-sm btn-primary" onclick="sendForgivenessRequest('${period}','${safeMgr}')">Send to Commissioner</button>
      <button class="btn btn-sm btn-secondary" onclick="toggleForgivenessForm('${period}')">Cancel</button>
    </div>
  </div>`;

  return html;
}

// The commissioner's half: the extra context and controls attached to a late manager's row in the
// pending queue. A plain late submission just needs its start date shown before Approve is
// pressed; a plea needs a date picker, because granting it IS choosing the date.
function buildForgivenessControls(period, managerName, sub) {
  const state = submissionLateState(sub);
  if (!state.late) return '';
  const safeName = jsStr(managerName);
  const win = SUBMISSION_WINDOWS[period] || {};
  const inputId = `forgive-date-${period}-${managerName.replace(/[^A-Za-z0-9]/g, '-')}`;

  if (!state.forgivenessPending) {
    const granted = state.forgivenessGranted ? ' (back-dated by you)' : '';
    return `<div style="padding:0.4rem 0.5rem;margin:0.35rem 0;background:#fff3cd;border-radius:4px;border:1px solid #ffc107;font-size:0.8rem;color:#856404;">
      <strong>Late submission.</strong> Approving starts this roster on ${esc(fmtEffectiveDate(state.effectiveDate) || 'the next viable day')}${granted}.
    </div>`;
  }

  const defaultDate = win.period_start || state.autoEffectiveDate || '';
  return `<div style="padding:0.5rem;margin:0.35rem 0;background:#e7f1ff;border-radius:4px;border:1px solid #6ea8fe;">
    <div style="font-size:0.8rem;color:#084298;font-weight:600;margin-bottom:0.25rem;">Asking for forgiveness</div>
    ${state.reason ? `<div style="font-size:0.8rem;color:#084298;font-style:italic;margin-bottom:0.4rem;">&ldquo;${esc(state.reason)}&rdquo;</div>` : ''}
    <div style="font-size:0.78rem;color:#084298;margin-bottom:0.4rem;">Without forgiveness this roster starts ${esc(fmtEffectiveDate(state.autoEffectiveDate) || 'on the next viable day')}. Granting lets you set any day inside the period &mdash; including its first.</div>
    <div style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;">
      <input type="date" id="${inputId}" class="form-input" style="max-width:11rem;" value="${esc(defaultDate)}"${win.period_start ? ` min="${esc(win.period_start)}"` : ''}${win.period_end ? ` max="${esc(win.period_end)}"` : ''}>
      <button class="btn btn-sm btn-success" onclick="decideForgiveness('${period}','${safeName}','grant','${inputId}')">Grant Back-Date</button>
      <button class="btn btn-sm btn-danger" onclick="decideForgiveness('${period}','${safeName}','deny','${inputId}')">Deny</button>
    </div>
  </div>`;
}

// Build a submission card for a given period (pp2, qf, sf, finals)
function buildPeriodSubmissionCard(period, periodLabel, managerName, isCommissioner, seasonData) {
  const safeMgr = jsStr(managerName);
  const sub = getPeriodSub(seasonData, period, managerName);
  const isApproved = sub && sub.status === 'approved';
  const isPending = sub && sub.status === 'pending';
  const batters = sub ? sub.batters || [] : [];
  const pitchers = sub ? sub.pitchers || [] : [];

  const poolBatCount = (seasonData.batters_pool || []).length;
  const poolPitCount = (seasonData.pitchers_pool || []).length;
  const poolReady = poolBatCount > 0 && poolPitCount > 0;

  const deadline = getPeriodDeadline(seasonData, period);
  const isOpen = isPeriodTimeOpen(seasonData, period);
  const openDate = getPeriodOpenDate(seasonData, period);
  const qualified = isManagerQualifiedForPeriod(managerName, period, seasonData);

  const fmtDeadline = (d) =>
    d
      ? d.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
      : '';

  let html = `<div class="card initial-submission-section" id="period-submission-card-${period}" style="margin-top:1rem;">
    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
      <span class="swap-badge" style="background:var(--primary);color:#fff;font-size:0.8rem;">${periodLabel}</span>
      <h3 style="margin:0;">Player Submission</h3>
    </div>
    <p class="text-muted" style="margin-bottom:0.75rem;">Submit your roster for ${periodLabel}: 4 batters and 3 pitchers</p>`;

  const eliminatedInRound = seasonData && seasonData.eliminated && seasonData.eliminated[managerName];
  const periodIsEliminated = isManagerEliminatedForPeriod(seasonData, managerName, period);

  // Late mode: the SERVER says this period's lock has passed and this manager still has no
  // approved roster for it. The form stays up — what changes is the date it starts on and the
  // buttons underneath it. Gated on the server's answer rather than the local deadline so a
  // manager's clock (or a missing period_deadlines entry) can never move his start date.
  const lateMode =
    !isApproved &&
    poolReady &&
    qualified &&
    !periodIsEliminated &&
    periodIsLate(period) &&
    periodStillRunning(period, sub);

  if (!qualified && !isApproved) {
    html += `<div style="padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
      <p class="text-muted" style="font-size:0.85rem;margin:0;">You have not qualified for ${periodLabel}.</p>
    </div>`;
  } else if (periodIsEliminated && !isApproved) {
    const roundLabels = { PP: 'Pool Play', QF: 'Quarterfinals', SF: 'Semifinals' };
    html += `<div style="padding:0.75rem;background:#fff3cd;border-radius:6px;border:1px solid #ffc107;">
      <p style="font-size:0.85rem;margin:0;color:#856404;">Season ended in ${roundLabels[eliminatedInRound] || eliminatedInRound}. Better luck next year.</p>
    </div>`;
  } else if (isApproved) {
    html += `<div class="swap-badge swap-badge-approved" style="margin-bottom:0.75rem;">Approved by Commissioner</div>`;
    html += `<div class="wrs-group-label">BATTERS (${batters.length}/4)</div>`;
    html += '<div class="comm-player-list">';
    batters.forEach((b) => {
      html += `<div class="comm-player-item"><span>${displayPlayer(b, seasonData)}</span></div>`;
    });
    html += '</div>';
    html += `<div class="wrs-group-label" style="margin-top:0.5rem;">PITCHERS (${pitchers.length}/3)</div>`;
    html += '<div class="comm-player-list">';
    pitchers.forEach((p) => {
      html += `<div class="comm-player-item"><span>${displayPlayer(p, seasonData)}</span></div>`;
    });
    html += '</div>';
    if (isOpen) {
      const editNote = deadline
        ? `Editing available until <strong>${fmtDeadline(deadline)}</strong>. Re-editing requires commissioner re-approval.`
        : 'Re-editing will require commissioner re-approval. Set a deadline in Season Setup to lock submissions before the first game.';
      html += `<div style="margin-top:1rem;padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
        <button class="btn btn-secondary" onclick="editApprovedPeriodSubmission('${period}','${safeMgr}')">Edit Submission</button>
        <p class="text-muted" style="margin-top:0.5rem;margin-bottom:0;font-size:0.82rem;">${editNote}</p>
      </div>`;
    }
  } else if (!poolReady) {
    html += `<p class="text-muted" style="font-size:0.85rem;">Waiting for commissioner to upload player pool. If you expect it to be ready, <a href="#" onclick="location.reload();return false;">refresh the page</a>.</p>`;
  } else if (!isOpen && !lateMode) {
    if (openDate && Date.now() < openDate.getTime()) {
      const openStr = openDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      html += `<div style="padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
        <p class="text-muted" style="font-size:0.85rem;margin:0;">Submission window opens <strong>${openStr}</strong>${deadline ? ` and closes at <strong>${fmtDeadline(deadline)}</strong>` : ''}.</p>
      </div>`;
    } else if (deadline && Date.now() >= deadline.getTime()) {
      html += `<p class="text-muted" style="font-size:0.85rem;">Submission window has closed.</p>`;
    } else {
      html += `<p class="text-muted" style="font-size:0.85rem;">Submission deadline not yet configured by commissioner.</p>`;
    }
  } else {
    // Editable form
    if (lateMode) html += buildLateSubmissionBanner(period, periodLabel, sub);
    if (isPending) {
      html += `<div class="swap-badge swap-badge-pending" style="margin-bottom:0.75rem;">Pending Commissioner Approval</div>
      <p class="text-muted" style="font-size:0.82rem;margin-bottom:0.75rem;">You can still modify your roster until the commissioner approves it.</p>`;
    }
    if (deadline && !lateMode) {
      html += `<p class="text-muted" style="font-size:0.82rem;margin-bottom:0.75rem;">Submission deadline: <strong>${fmtDeadline(deadline)}</strong></p>`;
    }

    const batInputId = `period-add-bat-${period}`;
    const pitInputId = `period-add-pit-${period}`;

    html += `<div class="wrs-group-label">BATTERS (${batters.length}/4)</div>
    <div id="period-sub-batters-${period}">`;
    if (batters.length > 0) {
      html += '<div class="comm-player-list">';
      batters.forEach((b) => {
        const safeB = jsStr(b);
        html += `<div class="comm-player-item"><span>${displayPlayer(b, seasonData)}</span>
          <button class="btn btn-sm btn-danger" onclick="removePeriodPlayer('${period}','${safeMgr}','batters','${safeB}')">Remove</button></div>`;
      });
      html += '</div>';
    }
    html += '</div>';
    if (batters.length < 4) {
      html += `<div class="roster-add-row player-search-container" style="margin-top:0.5rem;">
        <input type="text" id="${batInputId}" class="form-input player-search-input" placeholder="Type to search batters..." autocomplete="off" data-pool-type="batters" data-week-key="period-${period}" data-manager="${safeMgr}">
        <div class="player-search-results" id="results-${batInputId}"></div>
        <button class="btn btn-sm btn-primary" onclick="addPeriodPlayer('${period}','${safeMgr}','batters')">Add</button>
      </div>`;
    }

    html += `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${pitchers.length}/3)</div>
    <div id="period-sub-pitchers-${period}">`;
    if (pitchers.length > 0) {
      html += '<div class="comm-player-list">';
      pitchers.forEach((p) => {
        const safeP = jsStr(p);
        html += `<div class="comm-player-item"><span>${displayPlayer(p, seasonData)}</span>
          <button class="btn btn-sm btn-danger" onclick="removePeriodPlayer('${period}','${safeMgr}','pitchers','${safeP}')">Remove</button></div>`;
      });
      html += '</div>';
    }
    html += '</div>';
    if (pitchers.length < 3) {
      html += `<div class="roster-add-row player-search-container" style="margin-top:0.5rem;">
        <input type="text" id="${pitInputId}" class="form-input player-search-input" placeholder="Type to search pitchers..." autocomplete="off" data-pool-type="pitchers" data-week-key="period-${period}" data-manager="${safeMgr}">
        <div class="player-search-results" id="results-${pitInputId}"></div>
        <button class="btn btn-sm btn-primary" onclick="addPeriodPlayer('${period}','${safeMgr}','pitchers')">Add</button>
      </div>`;
    }

    if (lateMode) {
      html += buildLateSubmissionControls(period, periodLabel, managerName, batters, pitchers, sub);
    } else if (!isPending) {
      const allSelected = batters.length === 4 && pitchers.length === 3;
      const missing = [];
      if (batters.length < 4) missing.push(`${4 - batters.length} batter${batters.length < 3 ? 's' : ''}`);
      if (pitchers.length < 3) missing.push(`${3 - pitchers.length} pitcher${pitchers.length < 2 ? 's' : ''}`);
      html += `<div style="margin-top:1rem;">
        <button class="btn btn-primary"${allSelected ? '' : ' disabled style="opacity:0.45;cursor:not-allowed;"'}
          onclick="${allSelected ? `submitPeriodRoster('${period}','${safeMgr}')` : ''}">Submit for Approval</button>
        <p class="text-muted" style="margin-top:0.5rem;font-size:0.82rem;">${allSelected ? 'All players selected — ready to submit.' : `Still need: ${missing.join(' and ')}.`}</p>
      </div>`;
    }
  }

  // Commissioner approval section for this period.
  //
  // The queue spans managers, so its heading uses the period's neutral name (in the Finals
  // period, both games) rather than the card owner's — but each row is one manager, and in the
  // Finals period which of the two games he submitted for is the thing being approved, so it
  // rides next to his name.
  if (isCommissioner) {
    const allManagers = getManagers().filter((m) => m.active !== false);
    const pendingPeriod = allManagers.filter((m) => {
      const s = getPeriodSub(seasonData, period, m.name);
      return s && s.status === 'pending';
    });
    if (pendingPeriod.length > 0) {
      const field = period === 'finals' ? finalsGameField(seasonData) : null;
      html += `<div class="swap-pending-card" style="margin-top:1rem;"><h4>Pending ${periodLabelForAll(period)} Approvals</h4>`;
      pendingPeriod.forEach((m) => {
        const s = getPeriodSub(seasonData, period, m.name);
        const safeName = jsStr(m.name);
        const gameLabel = field ? submissionPeriodLabel(seasonData, period, m.name, field) : '';
        const gameTag =
          gameLabel && gameLabel !== FINALS_GAME_LABELS.unknown
            ? `<span class="text-muted" style="font-size:0.78rem;">${esc(gameLabel)}</span>`
            : '';
        html += `<div class="swap-pending-item">
          <div class="swap-pending-header"><span style="display:flex;align-items:baseline;gap:0.4rem;"><strong>${esc(m.name)}</strong>${gameTag}</span><span class="swap-badge swap-badge-pending">Pending</span></div>
          <div style="padding:0.5rem 0;">
            <div style="font-size:0.82rem;"><strong>Batters:</strong> ${(s.batters || []).join(', ') || 'None'}</div>
            <div style="font-size:0.82rem;"><strong>Pitchers:</strong> ${(s.pitchers || []).join(', ') || 'None'}</div>
          </div>
          ${buildForgivenessControls(period, m.name, s)}
          <div class="swap-pending-actions">
            <button class="btn btn-sm btn-success" onclick="approvePeriodSubmission('${period}','${safeName}')">Approve</button>
            <button class="btn btn-sm btn-danger" onclick="denyPeriodSubmission('${period}','${safeName}')">Deny</button>
          </div>
        </div>`;
      });
      html += '</div>';
    }
  }

  html += '</div>';
  return html;
}

// Swap form: toggle between Batter and Pitcher
window.swapTypeToggle = function (type) {
  const batterBtn = document.getElementById('swap-type-batter');
  const pitcherBtn = document.getElementById('swap-type-pitcher');
  const outSelect = document.getElementById('swap-player-out');
  const inSelect = document.getElementById('swap-player-in');
  const dataEl = document.getElementById('swap-roster-data');
  if (!dataEl) return;

  const data = JSON.parse(dataEl.textContent);
  const teamMap = Object.assign({}, data.battersTeam || {}, data.pitchersTeam || {});
  const dp = (name) => {
    const t = teamMap[name];
    return t && !name.endsWith(`(${t})`) ? `${name} (${t})` : name;
  };

  const clearSwapInSearch = () => {
    const searchEl = document.getElementById('swap-player-in-search');
    const resultsEl = document.getElementById('swap-player-in-results');
    if (searchEl) searchEl.value = '';
    if (inSelect) inSelect.value = '';
    if (resultsEl) {
      resultsEl.innerHTML = '';
      resultsEl.style.display = 'none';
    }
  };

  if (type === 'batter') {
    batterBtn.classList.add('active');
    pitcherBtn.classList.remove('active');
    outSelect.innerHTML =
      '<option value="">Select player to swap out...</option>' +
      data.batters.map((b) => `<option value="${b}">${dp(b)}</option>`).join('');
    clearSwapInSearch();
  } else {
    pitcherBtn.classList.add('active');
    batterBtn.classList.remove('active');
    outSelect.innerHTML =
      '<option value="">Select player to swap out...</option>' +
      data.pitchers.map((p) => `<option value="${p}">${dp(p)}</option>`).join('');
    clearSwapInSearch();
  }
  window.refreshSwapAutoEffectiveDate(); // both selections were reset — back to the no-player baseline
};

// Determine which schedule round the current date falls in. Between weeks (e.g. the All-Star
// break or a round gap) this returns the UPCOMING round — that's the roster a swap made in the
// gap affects, so that's the round it's charged against. The server recomputes this
// authoritatively at swap submission (currentScheduleRound in server.js — keep in step).
// The swap-limit rules themselves (checkSwapLimit) live in js/swaps.js.
function getCurrentScheduleRound(sd) {
  const dates = sd.schedule_dates;
  if (!dates || dates.length === 0) return { round: 'PP1', weekKey: null };
  const today = fmtDateISO(new Date());
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    const d = dates[i];
    if (d && today <= d.end) {
      return { round: SEASON_SCHEDULE[i].round, weekKey: `${SEASON_SCHEDULE[i].round}|${SEASON_SCHEDULE[i].week}` };
    }
  }
  // After the last week: use the final round.
  const last = SEASON_SCHEDULE[SEASON_SCHEDULE.length - 1];
  return { round: last.round, weekKey: `${last.round}|${last.week}` };
}

// Look up a player's MLB team abbreviation from the season's team maps.
function getPlayerTeam(sd, playerName) {
  if (!sd || !playerName) return null;
  return (sd.batters_team && sd.batters_team[playerName]) || (sd.pitchers_team && sd.pitchers_team[playerName]) || null;
}

// Format a Date as a YYYY-MM-DD string in Eastern time (matches how MLB games are
// dated and how the server computes "today").
function isoDateET(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Determine a swap's effective dates by checking whether either player's MLB team
// has already started playing today. A player whose game has begun can't be swapped
// in or out, so the swap takes effect the following day; otherwise it takes effect
// today. The drop date is always one day before the add date (the "Player In" date).
async function computeSwapEffectiveDates(sd, playerOut, playerIn) {
  const teams = [getPlayerTeam(sd, playerOut), getPlayerTeam(sd, playerIn)].filter(Boolean);

  const now = new Date();
  const todayStr = isoDateET(now);
  const yesterdayStr = isoDateET(new Date(now.getTime() - 86400000));
  const tomorrowStr = isoDateET(new Date(now.getTime() + 86400000));

  let anyStarted = false;
  let startedTeams = [];
  if (teams.length) {
    try {
      const resp = await apiFetch(`/api/mlb/teams-started?teams=${encodeURIComponent(teams.join(','))}`);
      const data = await resp.json();
      anyStarted = !!data.any_started;
      startedTeams = data.started || [];
    } catch (e) {
      // On failure, fall back to "not started" (effective today) so swaps stay usable.
      console.error('teams-started check failed:', e);
    }
  }

  if (anyStarted) {
    // A team's game has begun — effective tomorrow (drop today, add tomorrow).
    return { effective_date: tomorrowStr, drop_date: todayStr, add_date: tomorrowStr, teams_started: startedTeams };
  }
  // No games started yet — effective today (drop yesterday, add today).
  return { effective_date: todayStr, drop_date: yesterdayStr, add_date: todayStr, teams_started: [] };
}

// Keep the swap form's Effective Date input showing the date the swap WOULD take effect if
// submitted as-is (the auto path): today, or tomorrow once either selected player's team has
// started playing. Called whenever a player selection changes. Only overwrites the input while
// it still holds the previous auto value (or is empty) — a date the user picked themselves is
// never clobbered. data-auto-date always tracks the latest auto value so submitSwapRequest can
// tell "left as suggested" (auto path) apart from "changed" (scheduled swap).
window.refreshSwapAutoEffectiveDate = async function () {
  const effEl = document.getElementById('swap-effective-date');
  if (!effEl) return;
  const sd = getSeasons()[SELECTED_SEASON];
  if (!sd) return;
  const playerOut = (document.getElementById('swap-player-out') || {}).value || '';
  const playerIn = (document.getElementById('swap-player-in') || {}).value || '';
  const prevAuto = effEl.dataset.autoDate || '';
  const { effective_date: autoDate } = await computeSwapEffectiveDates(sd, playerOut, playerIn);
  // Re-look-up after the await: the form may have re-rendered while the check was in flight.
  const el = document.getElementById('swap-effective-date');
  if (!el) return;
  el.dataset.autoDate = autoDate;
  if (!el.value || el.value === prevAuto) el.value = autoDate;
};

// Submit a swap request
window.submitSwapRequest = async function (managerName, ev) {
  const errEl = document.getElementById('swap-form-error');
  const succEl = document.getElementById('swap-form-success');
  errEl.style.display = 'none';
  succEl.style.display = 'none';
  _swapFormNotice = null;

  // Double-submit guard: computeSwapEffectiveDates below awaits a live-schedule network call, leaving
  // a window where a second click fired a second identical request (the "commissioner got the swap
  // twice" bug). Disable the button while this submission is in flight. The server also dedupes
  // identical pending swaps as a backstop, but blocking the second request here is cleaner.
  const btnEl = (ev && ev.currentTarget) || (typeof event !== 'undefined' && event && event.currentTarget) || null;
  if (btnEl) {
    if (btnEl.dataset.submitting === '1') return;
    btnEl.dataset.submitting = '1';
    btnEl.disabled = true;
  }
  const clearSubmitting = () => {
    if (btnEl) {
      btnEl.dataset.submitting = '';
      btnEl.disabled = false;
    }
  };

  try {
    const playerOut = document.getElementById('swap-player-out').value;
    const playerIn = document.getElementById('swap-player-in').value;
    const reason = document.getElementById('swap-reason').value;
    // The date input is prefilled with the auto effective date (data-auto-date, kept fresh by
    // refreshSwapAutoEffectiveDate). Only a date STRICTLY AFTER today schedules the swap. Today
    // is never a "scheduled" date — it means "apply now", which is the auto path: the selected
    // players' teams' game start times decide whether that lands today or tomorrow. So today is
    // always submittable, even if data-auto-date has drifted (a re-render, a stale game-start
    // check, or the manager typing the date back in).
    const effEl = document.getElementById('swap-effective-date');
    const todayET = isoDateET(new Date());
    const effValue = (effEl && effEl.value) || '';
    const requestedEff = effValue > todayET && effValue !== (effEl.dataset.autoDate || '') ? effValue : '';
    const swapDate = new Date().toISOString().split('T')[0];

    if (!playerOut || !playerIn || !reason) {
      errEl.textContent = 'All fields are required.';
      errEl.style.display = 'block';
      return;
    }

    // Only backdating is blocked — today is allowed (it applies the swap now, subject to the
    // game-start rule). The server re-validates and lets only the commissioner pick past dates,
    // via the Swap Log editor.
    if (effValue && effValue < todayET) {
      errEl.textContent =
        'The effective date cannot be in the past — keep today to apply the swap now, or pick a later date to schedule it.';
      errEl.style.display = 'block';
      return;
    }

    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd || sd.status !== 'active') {
      errEl.textContent = 'No active season.';
      errEl.style.display = 'block';
      return;
    }

    if (!sd.swaps) sd.swaps = [];

    const { round, weekKey } = getCurrentScheduleRound(sd);

    // Pre-check the swap limits for this round (js/swaps.js) for fast feedback; the server
    // re-validates authoritatively at submission and blocks ineligible swaps the same way.
    const limitError = checkSwapLimit(sd.swaps, managerName, reason, round);
    if (limitError) {
      errEl.textContent = limitError;
      errEl.style.display = 'block';
      return;
    }

    // Determine effective add/drop dates: a scheduled swap uses the chosen date (add on the
    // date, drop the day before — the game-started rule is irrelevant for a future date);
    // otherwise ask the live game schedule. The server recomputes both cases authoritatively.
    let eff;
    if (requestedEff) {
      const d = new Date(requestedEff + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      eff = {
        effective_date: requestedEff,
        drop_date: d.toISOString().split('T')[0],
        add_date: requestedEff,
        teams_started: [],
      };
    } else {
      eff = await computeSwapEffectiveDates(sd, playerOut, playerIn);
    }
    const { effective_date, drop_date, add_date, teams_started } = eff;

    // Same guard the server enforces (js/swaps.js): on a round's final day the game-started rule
    // rolls the add into the next period, where the swap can only do harm — it scores nothing this
    // round and adds the incoming player to a roster that was never submitted. Fast feedback here;
    // the server refuses authoritatively. Only the auto path can hit this — a scheduled date is
    // already bounded by the end-of-round check above.
    if (!requestedEff) {
      const windowError = checkSwapEffectiveWindow(add_date, scheduleRoundEnd(sd, round), round, playerIn);
      if (windowError) {
        errEl.textContent = windowError;
        errEl.style.display = 'block';
        return;
      }
    }

    const swap = {
      email: LOGGED_IN_EMAIL,
      manager: managerName,
      player_out: playerOut,
      player_in: playerIn,
      reason: reason,
      swap_date: swapDate,
      effective_date: effective_date,
      drop_date: drop_date,
      add_date: add_date,
      teams_started: teams_started,
      round: round,
      week_key: weekKey,
    };
    if (requestedEff) swap.requested_effective_date = requestedEff;

    // Post only the swap object to the dedicated endpoint — avoids the whole-season
    // payload that previously failed silently when the JSON was large or auth was stale.
    try {
      const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/swaps`, {
        method: 'POST',
        body: JSON.stringify(swap),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${resp.status})`);
      }
      const { swap: savedSwap, _rev, pending_review: pendingReview } = await resp.json();

      // Mirror the confirmed server swap into localStorage so the view is consistent. Dedupe by id:
      // if the server returned an already-existing swap (duplicate guard), don't add a second
      // local copy.
      const freshSeasons = getSeasons();
      const freshSd = freshSeasons[SELECTED_SEASON];
      if (freshSd) {
        if (!Array.isArray(freshSd.swaps)) freshSd.swaps = [];
        if (!freshSd.swaps.some((s) => String(s.id) === String(savedSwap.id))) freshSd.swaps.push(savedSwap);
        if (_rev) freshSd._rev = _rev; // adopt the token bumped by this swap so the next save isn't stale
        setSeasonsLocal(freshSeasons);
      }

      // An auto-applied swap rebuilt rosters/roster_dates/weekly scores server-side — pull down the
      // authoritative season so the roster view reflects the swap immediately (same pattern as the
      // commissioner approve flow).
      if (!pendingReview) {
        try {
          const fresh = await fetch('/api/seasons');
          if (fresh.ok) {
            const srv = await fresh.json();
            if (srv && Object.keys(srv).length > 0) setSeasonsLocal(srv);
          }
        } catch (_) {
          /* offline — local view may lag until reload */
        }
      }

      // Bake the confirmation into the form render (via _swapFormNotice) BEFORE re-rendering:
      // the re-render replaces the whole form DOM (and renders again when daily stats land), so
      // a message written directly to the old elements would be wiped instantly.
      _swapFormNotice = {
        type: 'success',
        text: pendingReview
          ? 'Swap submitted — it was flagged for commissioner review and will take effect once approved.'
          : `Swap ${requestedEff ? 'scheduled' : 'applied'}! ${playerOut} out, ${playerIn} in — effective ${
              (savedSwap && (savedSwap.effective_date || savedSwap.add_date)) || 'today'
            }.`,
      };
      renderRosterData(managerName, isLoggedInCommissioner());
    } catch (e) {
      errEl.textContent = `Swap not applied — ${e.message}`;
      errEl.style.display = 'block';
      return;
    }
  } finally {
    clearSubmitting();
  }
};

// Sync add-date input to one day after drop-date when drop-date changes
window.syncSwapAddDate = function (dropDateId, addDateId) {
  const dropEl = document.getElementById(dropDateId);
  const addEl = document.getElementById(addDateId);
  if (!dropEl || !addEl || !dropEl.value) return;
  const d = new Date(dropEl.value + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  addEl.value = d.toISOString().split('T')[0];
};

// Commissioner swap actions re-render the roster view; re-render WHICHEVER roster the
// manager picker is currently showing instead of snapping back to the commissioner's own
// team (the "I was adjusting someone else's roster and it reset to mine" annoyance).
function rerenderCurrentRosterView() {
  const mgrs = getManagers();
  const dd = document.getElementById('roster-manager-dropdown');
  const viewing = dd && dd._dd ? dd._dd.getValue() : '';
  const name =
    viewing && mgrs.some((m) => m.name === viewing)
      ? viewing
      : (mgrs.find((m) => m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase()) || {}).name;
  if (name) renderRosterData(name, true);
}

// Commissioner: approve a swap
window.approveSwap = async function (swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find((s) => s.id === swapId);
  if (!swap) return;

  // Read commissioner-set effective dates from the UI (fall back to today / tomorrow). The SERVER now
  // performs the roster swap, roster_dates windows, and stat attribution atomically — see
  // POST /api/seasons/:year/swaps/:id/approve. Doing it server-side means the approval can't be lost
  // to a stale-save 409 (the bug where an approved swap came back as pending).
  const _fallbackToday = new Date().toISOString().split('T')[0];
  const _fallbackTomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  })();
  const dropDateEl =
    document.getElementById(`swap-drop-date-${swapId}`) || document.getElementById(`comm-drop-date-${swapId}`);
  const addDateEl =
    document.getElementById(`swap-add-date-${swapId}`) || document.getElementById(`comm-add-date-${swapId}`);
  const effectiveDropDate = (dropDateEl && dropDateEl.value) || swap.drop_date || _fallbackToday;
  const effectiveAddDate = (addDateEl && addDateEl.value) || swap.add_date || _fallbackTomorrow;

  const doApprove = (force) =>
    apiFetch(`/api/seasons/${SELECTED_SEASON}/swaps/${swapId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ add_date: effectiveAddDate, drop_date: effectiveDropDate, force }),
    });

  try {
    let resp = await doApprove(false);
    // The server guards against an approval that would crater a manager's total / shrink a roster.
    // Offer the commissioner an explicit override for a legitimate large correction.
    if (resp.status === 409) {
      const body = await resp.json().catch(() => ({}));
      if (body.error === 'destructive_approve_blocked') {
        const reasons = (body.reasons || []).join('\n• ');
        if (!confirm(`This approval looks destructive:\n\n• ${reasons}\n\nApply anyway?`)) return;
        resp = await doApprove(true);
      }
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(`Swap approval failed (${err.error || resp.status}). Please reload and try again.`);
      return;
    }
    // Pull down the authoritative season the server just rebuilt (rosters / roster_dates / weekly).
    try {
      const fresh = await fetch('/api/seasons');
      if (fresh.ok) {
        const srv = await fresh.json();
        if (srv && Object.keys(srv).length > 0) setSeasonsLocal(srv);
      }
    } catch (_) {
      /* offline — local view may lag until reload */
    }
  } catch (e) {
    alert(`Swap approval failed — ${e.message}. Please reload and try again.`);
    return;
  }

  renderPendingSwapRequests();
  renderSwapLog();
  startPendingSwapPoll();

  rerenderCurrentRosterView();
};

// Commissioner: deny a swap
window.denySwap = async function (swapId) {
  if (!confirm('Deny this swap request?')) return;

  // Atomic deny — flips status server-side; can't be lost to a stale-save 409 (the bug where a
  // denied request reappeared as pending).
  const result = await persistSwapMutation(SELECTED_SEASON, swapId, 'POST', '/deny', {});
  if (!result) return;

  renderPendingSwapRequests();
  renderSwapLog();
  startPendingSwapPoll();

  rerenderCurrentRosterView();
};

// Commissioner: cleanly undo an approved swap (for a mistake / test). Reverses it server-side —
// removes the added player and lifts the original player's drop — leaving no residual roster_dates
// that could form a broken window. See POST /api/seasons/:year/swaps/:id/undo.
window.undoSwap = async function (swapId) {
  if (
    !confirm(
      'Undo this swap? This removes the player that was added and restores the original player, as if the swap never happened.'
    )
  ) {
    return;
  }
  const doUndo = (force) =>
    apiFetch(`/api/seasons/${SELECTED_SEASON}/swaps/${swapId}/undo`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  try {
    let resp = await doUndo(false);
    if (resp.status === 409) {
      const body = await resp.json().catch(() => ({}));
      if (body.error === 'destructive_undo_blocked') {
        const reasons = (body.reasons || []).join('\n• ');
        if (!confirm(`This undo would significantly change totals:\n\n• ${reasons}\n\nApply anyway?`)) return;
        resp = await doUndo(true);
      } else if (body.error === 'swap_not_approved') {
        alert('Only an approved swap can be undone.');
        return;
      }
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(`Undo failed (${err.error || resp.status}). Please reload and try again.`);
      return;
    }
    // Pull down the authoritative season the server just rebuilt.
    try {
      const fresh = await fetch('/api/seasons');
      if (fresh.ok) {
        const srv = await fresh.json();
        if (srv && Object.keys(srv).length > 0) setSeasonsLocal(srv);
      }
    } catch (_) {
      /* offline — local view may lag until reload */
    }
  } catch (e) {
    alert(`Undo failed — ${e.message}. Please reload and try again.`);
    return;
  }
  renderPendingSwapRequests();
  renderSwapLog();
  startPendingSwapPoll();
  rerenderCurrentRosterView();
};

// Commissioner: show inline edit form for a swap
window.editSwapInline = function (swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find((s) => s.id === swapId);
  if (!swap) return;

  const editDiv = document.getElementById(`swap-edit-${swapId}`);
  const actionsDiv = document.getElementById(`swap-actions-${swapId}`);
  if (!editDiv) return;

  // Build available players for the swap target manager (per-week model)
  const allRostered = getAllRosteredPlayers(sd, swap.manager);
  const isBatter = allRostered.batters.includes(swap.player_out);
  const rosterPlayers = isBatter ? allRostered.batters : allRostered.pitchers;

  const rosteredAll = new Set();
  for (const mgrRoster of Object.values(sd.rosters || {})) {
    for (const weekRoster of Object.values(mgrRoster)) {
      (weekRoster.batters || []).forEach((b) => rosteredAll.add(b));
      (weekRoster.pitchers || []).forEach((p) => rosteredAll.add(p));
    }
  }
  const pool = isBatter ? sd.batters_pool || [] : sd.pitchers_pool || [];
  const availPlayers = pool.filter((p) => !rosteredAll.has(p) || p === swap.player_in).sort();

  editDiv.innerHTML = `
    <div class="swap-edit-grid">
      <div class="swap-form-field">
        <label>Player Out</label>
        <select id="edit-out-${swapId}" class="form-select">
          ${rosterPlayers
            .sort()
            .map(
              (p) => `<option value="${p}" ${p === swap.player_out ? 'selected' : ''}>${displayPlayer(p, sd)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="swap-form-field">
        <label>Player In</label>
        <select id="edit-in-${swapId}" class="form-select">
          ${availPlayers.map((p) => `<option value="${p}" ${p === swap.player_in ? 'selected' : ''}>${displayPlayer(p, sd)}</option>`).join('')}
        </select>
      </div>
      <div class="swap-form-field">
        <label>Reason</label>
        <select id="edit-reason-${swapId}" class="form-select">
          ${SWAP_REASONS.map((r) => `<option value="${r}" ${r === swap.reason ? 'selected' : ''}>${swapReasonLabel(r)}</option>`).join('')}
        </select>
      </div>
      <div class="swap-form-field">
        <label>Swap Date</label>
        <input type="date" id="edit-date-${swapId}" class="form-select" value="${swap.swap_date || ''}">
      </div>
      <div class="swap-form-field">
        <label>Drop Date (player out)</label>
        <input type="date" id="edit-drop-${swapId}" class="form-select" value="${swap.drop_date || ''}">
      </div>
      <div class="swap-form-field">
        <label>Add Date (player in)</label>
        <input type="date" id="edit-add-${swapId}" class="form-select" value="${swap.add_date || ''}">
      </div>
    </div>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
      <button class="btn btn-sm btn-primary" onclick="saveSwapEdit('${swapId}')">Save Changes</button>
      <button class="btn btn-sm btn-secondary" onclick="cancelSwapEdit('${swapId}')">Cancel</button>
    </div>`;
  editDiv.style.display = 'block';
  if (actionsDiv) actionsDiv.style.display = 'none';
};

// Commissioner: save edited swap
window.saveSwapEdit = async function (swapId) {
  const newOut = document.getElementById(`edit-out-${swapId}`).value;
  const newIn = document.getElementById(`edit-in-${swapId}`).value;
  const newReason = document.getElementById(`edit-reason-${swapId}`).value;
  const newDate = document.getElementById(`edit-date-${swapId}`).value;
  const newDrop = (document.getElementById(`edit-drop-${swapId}`) || {}).value || '';
  const newAdd = (document.getElementById(`edit-add-${swapId}`) || {}).value || '';

  // Atomic edit of the swap's own fields. For a pending swap this is record-only (approve reads
  // the dates later); the server re-applies roster windows if the swap is already approved.
  const body = {
    player_out: newOut,
    player_in: newIn,
    reason: newReason,
    swap_date: newDate,
  };
  if (newDrop) body.drop_date = newDrop;
  if (newAdd) body.add_date = newAdd;
  const result = await persistSwapMutation(SELECTED_SEASON, swapId, 'PUT', '', body);
  if (!result) return;

  rerenderCurrentRosterView();
};

// Commissioner: cancel editing a swap
window.cancelSwapEdit = function (swapId) {
  const editDiv = document.getElementById(`swap-edit-${swapId}`);
  const actionsDiv = document.getElementById(`swap-actions-${swapId}`);
  if (editDiv) editDiv.style.display = 'none';
  if (actionsDiv) actionsDiv.style.display = 'flex';
};

// ============================================================
// Commissioner Page
// ============================================================
function renderSubmissionStatusTable() {
  const container = document.getElementById('submission-status-table');
  if (!container) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) {
    container.innerHTML = '';
    return;
  }
  const activeManagers = getManagers()
    .filter((m) => m.active)
    .map((m) => m.name);

  const fmtDt = (iso) => (iso ? fmtServerTimestamp(iso) : '');

  // Managers to show for a period: Pool Play = all active managers; playoff rounds = only the
  // managers who advanced to that round (null until the prior round is finalized).
  //
  // The Finals period is the exception: ALL FOUR semifinalists submit for it — two for the
  // Championship, two for the 3rd-place game played over the same two weeks — so listing only
  // the two finalists hid half the rosters the commissioner has to chase and approve.
  const participantsFor = (period) => {
    if (period === 'pp1' || period === 'pp2') return activeManagers;
    if (period === 'qf') return getQFQualifiers(sd);
    if (period === 'sf' || period === 'finals') return getSFParticipants(sd);
    return null;
  };

  // Which of the two Finals-week games each of those four is in, once the semifinals are
  // finalized. Derived once — every read of it runs the bracket.
  const finalsField = finalsGameField(sd);

  const pendingNote = {
    qf: 'Advancing managers appear here once Pool Play is finalized.',
    sf: 'Semifinalists appear here once the Quarterfinals are finalized.',
    finals:
      'All four semifinalists appear here once the Quarterfinals are finalized — two play the Finals, two the 3rd-place game.',
  };

  const muted = (txt) => `<p class="text-muted" style="font-size:0.85rem;margin:0.5rem 0;">${txt}</p>`;

  // Per-period table + tallied counts.
  const tableFor = (period, names) => {
    let approved = 0;
    let pending = 0;
    let notSub = 0;
    const rows = names
      .map((name) => {
        const sub = getPeriodSub(sd, period, name);
        const status = sub ? sub.status : 'draft';
        const isApproved = !!sub && status === 'approved';
        const isPending = !!sub && status === 'pending';
        const isSubmitted = isApproved || isPending;
        if (isApproved) approved++;
        else if (isPending) pending++;
        else notSub++;

        // Late state rides the two cells that already exist rather than adding a column: a
        // missing roster on a locked period says so, and a submitted-late one shows the day it
        // actually starts counting from, which is the number the commissioner is approving.
        const late = submissionLateState(sub);
        const lateOpen = !isSubmitted && periodIsLate(period);
        const notCell = !isSubmitted
          ? `<td style="background:rgba(220,53,69,0.18);color:#dc3545;font-weight:600;text-align:center;white-space:nowrap;">Not Submitted${lateOpen ? '<div style="font-weight:500;font-size:0.72rem;">deadline passed</div>' : ''}</td>`
          : `<td style="text-align:center;color:var(--text-muted);">&#8212;</td>`;
        const lateNote = late.late
          ? `<div style="font-weight:500;font-size:0.72rem;">${
              late.forgivenessPending
                ? 'late &middot; begging'
                : `late &middot; from ${esc(late.effectiveDate || 'TBD')}`
            }</div>`
          : '';
        const subCell = isSubmitted
          ? `<td style="background:rgba(255,193,7,0.18);color:#9a7000;font-weight:600;text-align:center;white-space:nowrap;font-size:0.82rem;">${fmtDt(sub.submitted_at) || '&#8212;'}${lateNote}</td>`
          : `<td style="text-align:center;color:var(--text-muted);">&#8212;</td>`;
        const appCell = isApproved
          ? `<td style="background:rgba(40,167,69,0.18);color:#1a7a35;font-weight:600;text-align:center;white-space:nowrap;font-size:0.82rem;">${fmtDt(sub.approved_at) || '&#8212;'}</td>`
          : `<td style="text-align:center;color:var(--text-muted);">&#8212;</td>`;

        // In the Finals period the row says which of the two games this roster is for.
        const game = period === 'finals' ? submissionPeriodLabel(sd, period, name, finalsField) : '';
        const gameNote =
          game && game !== FINALS_GAME_LABELS.unknown
            ? `<div class="text-muted" style="font-weight:400;font-size:0.72rem;">${esc(game)}</div>`
            : '';
        return `<tr><td style="font-weight:500;">${esc(name)}${gameNote}</td>${notCell}${subCell}${appCell}</tr>`;
      })
      .join('');
    const table =
      `<table class="data-table" style="width:100%;margin:0.3rem 0 0.6rem;">` +
      `<thead><tr><th style="text-align:left;">Manager</th><th style="text-align:center;">Not Submitted</th>` +
      `<th style="text-align:center;">Submitted</th><th style="text-align:center;">Approved</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
    return { table, approved, pending, notSub };
  };

  // Auto-expand the latest period whose submission window has already opened and has participants
  // (= the round currently in play: PP2 while its window is open, then QF when that opens, etc.).
  const periods = ['pp1', 'pp2', 'qf', 'sf', 'finals'];
  const now = new Date();
  let defaultOpen = 'pp1';
  periods.forEach((p) => {
    const od = getPeriodOpenDate(sd, p);
    const opened = od ? od <= now : true;
    const names = participantsFor(p);
    if (opened && names && names.length) defaultOpen = p;
  });

  let html = '';
  periods.forEach((period) => {
    const names = participantsFor(period);
    let meta;
    let body;
    if (!names) {
      meta = 'pending finalization';
      body = muted(pendingNote[period] || 'Not yet available.');
    } else if (names.length === 0) {
      meta = 'no managers';
      body = muted('No managers for this round.');
    } else {
      const t = tableFor(period, names);
      const tail = t.notSub > 0 ? `${t.notSub} not submitted` : 'all submitted';
      meta = `${t.approved} approved &middot; ${t.pending} pending &middot; ${tail} (${names.length})`;
      body = t.table;
    }
    const openAttr = period === defaultOpen ? ' open' : '';
    html +=
      `<details class="sub-status-period"${openAttr}>` +
      `<summary><span class="sub-status-label">${periodLabelForAll(period)}</span>` +
      `<span class="sub-status-meta">${meta}</span></summary>${body}</details>`;
  });

  container.innerHTML = html;
}

function renderCommissioner() {
  const loginDiv = document.getElementById('commissioner-login');
  const panelDiv = document.getElementById('commissioner-panel');

  // Use the already-logged-in user — no separate login needed
  if (!LOGGED_IN_EMAIL) {
    loginDiv.style.display = 'block';
    loginDiv.innerHTML = '<h2>Commissioner</h2><p>Please log in to the app first.</p>';
    panelDiv.style.display = 'none';
    return;
  }

  const managers = getManagers();
  const mgr = managers.find(
    (m) => m.email && m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase() && m.commissioner
  );

  if (!mgr) {
    loginDiv.style.display = 'block';
    loginDiv.innerHTML = '<h2>Commissioner</h2><p>Your account does not have commissioner access.</p>';
    panelDiv.style.display = 'none';
    return;
  }

  COMMISSIONER_EMAIL = LOGGED_IN_EMAIL;
  loginDiv.style.display = 'none';
  showCommissionerPanel();
}

function backfillSubmissionTimestamps() {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.initial_submissions) return;

  // Best available proxy: PP1 Week 1 start date (same date used as roster add_date on approval)
  const pp1Start = sd.schedule_dates && sd.schedule_dates[0] ? sd.schedule_dates[0].start : null;
  const fallbackIso = pp1Start ? new Date(pp1Start).toISOString() : new Date().toISOString();

  let dirty = false;
  for (const sub of Object.values(sd.initial_submissions)) {
    if (!sub || !sub.status || sub.status === 'draft') continue;
    if (!sub.submitted_at) {
      sub.submitted_at = fallbackIso;
      dirty = true;
    }
    if (sub.status === 'approved' && !sub.approved_at) {
      sub.approved_at = fallbackIso;
      dirty = true;
    }
  }
  if (dirty) saveSeason(SELECTED_SEASON, sd);
}

function showCommissionerPanel() {
  document.getElementById('commissioner-login').style.display = 'none';
  document.getElementById('commissioner-panel').style.display = 'block';

  const managers = getManagers();
  const mgr = managers.find((m) => m.email.toLowerCase() === COMMISSIONER_EMAIL);
  document.getElementById('commissioner-name').textContent = mgr ? mgr.name : COMMISSIONER_EMAIL;
  document.getElementById('season-setup-title').textContent = `${SELECTED_SEASON} Initial Player Pool`;

  setupCommTabs();
  renderCommissionerTodo();
  refreshTodoAudit();
  refreshTodoSyncStatus();
  renderBannerBgSection();
  renderPendingSwapRequests();
  backfillSubmissionTimestamps();
  renderSubmissionStatusTable();
  renderSwapLog();
  renderManagersTable();
  renderPlayerPoolDisplay();
  renderMLBSyncLog();
  renderWeeklyUploadSections();
  setupPlayerPoolUploads();
  setupSeasonSetupToggle();
  setupAutoFillButton();
  setupASGDateInput();
  setupPeriodDeadlineInputs();
}

function setupCommTabs() {
  const bar = document.querySelector('.comm-tabs');
  if (!bar || bar._bound) return;
  bar._bound = true;
  bar.querySelectorAll('.comm-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.comm-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('#commissioner-panel .comm-tab-content').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.commTab);
      if (target) target.classList.add('active');
    });
  });
}

// Per-container filter + row-expansion state, kept across re-renders so background
// polling and reason edits don't reset the user's filters or close open details.
const _swapLogState = {};
function getSwapLogState(containerId) {
  if (!_swapLogState[containerId]) {
    // manager/type: '' = "All" (no filtering). scopeManager pins the log to a single manager
    // (the My Roster copy) — unlike the `manager` filter it is not user-changeable.
    _swapLogState[containerId] = { manager: '', type: '', expanded: new Set(), editable: false, scopeManager: null };
  }
  return _swapLogState[containerId];
}

// Label used in the Type filter for swaps that have no reason recorded.
const SWAP_NO_REASON_LABEL = '(No reason)';

// Format a server-stamped timestamp ("YYYY-MM-DD HH:MM:SS" UTC or full ISO) in the
// viewer's local timezone. parseServerTimestamp treats zone-less strings as UTC —
// the server stamps them that way — so the browser handles the zone + DST math.
// timeZoneName:'short' appends the viewer's zone abbreviation (EDT/EST/PDT…) so
// there's no ambiguity about which timezone a displayed time is in.
function fmtServerTimestamp(ts) {
  if (!ts) return '—';
  const d = parseServerTimestamp(ts);
  if (!d) return esc(ts);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' })
  );
}

// Local-timezone YYYY-MM-DD of a server-stamped timestamp (for date-only columns).
function serverTimestampLocalDate(ts) {
  const d = parseServerTimestamp(ts);
  return d ? fmtDateISO(d) : '';
}

// True while an approved swap's add date is still in the future — the swap is recorded but has
// not taken effect yet, so both rosters are still the pre-swap ones.
function swapIsScheduled(s) {
  if (!s || s.status !== 'approved') return false;
  const effective = s.add_date || s.requested_effective_date || s.effective_date;
  return !!effective && effective > isoDateET(new Date());
}

function swapStatusBadge(s) {
  if (s.status === 'approved') {
    const scheduled = swapIsScheduled(s)
      ? ` <span class="swap-badge swap-badge-scheduled">Scheduled ${fmtShortDate(s.add_date || s.requested_effective_date || s.effective_date)}</span>`
      : '';
    return `<span class="swap-badge swap-badge-approved">Approved</span>${scheduled}`;
  }
  if (s.status === 'denied') return '<span class="swap-badge swap-badge-denied">Denied</span>';
  if (s.status === 'undone') return '<span class="swap-badge swap-badge-denied">Undone</span>';
  return '<span class="swap-badge swap-badge-pending">Pending</span>';
}

// Build the expandable detail panel shown when a swap row is clicked. When `editable`
// is true (commissioner), the Reason row is an inline dropdown — on mobile the Reason
// column is hidden, so the panel is the only place a commissioner can edit it.
function swapDetailHtml(s, sd, containerId, editable) {
  const row = (label, value) =>
    `<div class="swap-detail-item"><span class="swap-detail-key">${label}</span><span class="swap-detail-val">${value}</span></div>`;

  let reasonVal;
  if (editable) {
    const reason = s.reason || '';
    const opts = COMMISSIONER_SWAP_REASONS.map(
      (r) => `<option value="${esc(r)}"${r === reason ? ' selected' : ''}>${esc(swapReasonLabel(r))}</option>`
    ).join('');
    reasonVal = `<select class="swap-detail-reason" onclick="event.stopPropagation()" onchange="saveSwapLogReason('${containerId}','${s.id}', this.value)">${opts}</select>`;
  } else {
    reasonVal = s.reason ? esc(swapReasonLabel(s.reason)) : '—';
  }

  let items = '';
  items += row('Manager', esc(s.manager || '—'));
  items += row('Player Out', displayPlayer(s.player_out || '—', sd));
  items += row('Player In', displayPlayer(s.player_in || '—', sd));
  items += row('Reason', reasonVal);
  items += row('Status', swapStatusBadge(s));
  items += row('Submitted', fmtServerTimestamp(s.timestamp));
  if (s.reviewed_at) items += row('Reviewed', fmtServerTimestamp(s.reviewed_at));
  if (s.email) items += row('Submitted By', esc(s.email));
  if (s.round) items += row('Round', esc(s.round));
  if (s.week_key) items += row('Week', esc(s.week_key.replace('|', ' · ')));
  if (s.swap_date) items += row('Requested', esc(s.swap_date));
  // Commissioner: drop/add dates are inline-editable for pending/approved swaps (a date edit on
  // an approved swap moves the live roster windows server-side and recomputes scores). Denied/
  // undone swaps have no live windows, so their dates stay read-only history.
  const dateEditable = editable && (s.status === 'approved' || s.status === 'pending');
  const dateVal = (field, value) =>
    dateEditable
      ? `<input type="date" class="swap-detail-date-input" value="${esc(value || '')}" onclick="event.stopPropagation()" onchange="saveSwapLogDate('${containerId}','${s.id}','${field}', this.value)">`
      : esc(value || '—');
  if (s.drop_date || dateEditable) items += row('Drop Date', dateVal('drop_date', s.drop_date));
  if (s.add_date || dateEditable) items += row('Add Date', dateVal('add_date', s.add_date));
  if (s.effective_date) items += row('Effective', esc(s.effective_date));
  if (s.requested_effective_date) items += row('Scheduled For', esc(s.requested_effective_date));
  if (s.teams_started && s.teams_started.length) {
    items += row('Teams Already Playing', esc(s.teams_started.join(', ')));
  }
  // Commissioner-only Undo for an approved swap: cleanly reverses it (removes the added player,
  // restores the original) rather than stacking a reverse swap. See POST /swaps/:id/undo.
  const actions =
    s.status === 'approved' && isLoggedInCommissioner()
      ? `<div class="swap-detail-actions">
        <button class="btn btn-sm btn-danger" onclick="undoSwap('${jsStr(s.id)}')">Undo swap</button>
        <span class="swap-detail-actions-note">Removes ${esc(s.player_in || '')}, restores ${esc(s.player_out || '')}.</span>
      </div>`
      : managerSwapActionsHtml(s, sd, containerId);
  return `<div class="swap-detail-panel">${items}${actions}</div>`;
}

// A manager owns their swap right up until it takes effect: while it is still SCHEDULED they can
// change the effective date or the reason, or cancel it outright. Once the add date arrives the
// roster windows are live and only the commissioner can change it — the server enforces exactly
// this (swapModifyGuard); these controls just mirror it. Changing the PLAYERS means cancelling and
// resubmitting, so the swap limit and IL checks re-run on the submission path.
function managerSwapActionsHtml(s, sd, containerId) {
  const me = (findManagerByEmail(LOGGED_IN_EMAIL || '') || {}).name;
  if (!me || s.manager !== me || s.status !== 'approved') return '';

  const editId = `sched-edit-${containerId}-${s.id}`;
  if (!swapIsScheduled(s)) {
    return `<div class="swap-detail-actions">
        <span class="swap-detail-actions-note">This swap has already taken effect — ask the commissioner if it needs to change.</span>
      </div>`;
  }

  const effective = s.add_date || s.requested_effective_date || s.effective_date;
  const minDate = tomorrowET(); // strictly forward, same rule the submission path enforces
  const maxDate = scheduleRoundEnd(sd, s.round || (getCurrentScheduleRound(sd) || {}).round);
  const reasonOpts = SWAP_REASONS.map(
    (r) => `<option value="${esc(r)}"${r === s.reason ? ' selected' : ''}>${esc(swapReasonLabel(r))}</option>`
  ).join('');

  return `<div class="swap-detail-actions">
      <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();toggleScheduledSwapEdit('${editId}')">Edit swap</button>
      <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();cancelScheduledSwap('${containerId}','${jsStr(s.id)}')">Cancel swap</button>
      <span class="swap-detail-actions-note">Scheduled for ${esc(effective)} — you can change or cancel it until then.</span>
    </div>
    <div class="swap-sched-edit" id="${editId}" style="display:none;" onclick="event.stopPropagation()">
      <div class="swap-sched-edit-fields">
        <label>
          <span>Effective Date</span>
          <input type="date" class="form-input" id="${editId}-date" value="${esc(effective || '')}" min="${esc(minDate)}"${maxDate ? ` max="${esc(maxDate)}"` : ''}>
        </label>
        <label>
          <span>Reason</span>
          <select class="form-select" id="${editId}-reason">${reasonOpts}</select>
        </label>
      </div>
      <div class="swap-sched-edit-actions">
        <button class="btn btn-sm btn-primary" onclick="saveScheduledSwap('${containerId}','${jsStr(s.id)}')">Save changes</button>
        <button class="btn btn-sm btn-secondary" onclick="toggleScheduledSwapEdit('${editId}')">Close</button>
        <span class="swap-detail-actions-note">To swap different players, cancel this swap and submit a new one.</span>
      </div>
      <p class="error-text" id="${editId}-error" style="display:none;"></p>
    </div>`;
}

// Render a labeled filter dropdown; the empty value means "All" (no filtering).
function swapFilterSelectHtml(containerId, label, kind, allValues, selected, allLabel) {
  const opts = [`<option value="">${esc(allLabel)}</option>`]
    .concat(allValues.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`))
    .join('');
  return `<label class="swap-log-filter">
    <span class="swap-log-filter-label">${label}</span>
    <select onchange="swapLogSetFilter('${containerId}','${kind}', this.value)">${opts}</select>
  </label>`;
}

// Render the swap log into `containerId`. When `editable` is true (commissioner),
// the reason cell becomes an inline dropdown; otherwise it is read-only. The same
// details are available to everyone via the click-to-expand row.
// `scopeManager` pins the log to one manager's swaps — the My Roster copy, which shows the same
// rows and the same expandable detail panel as the league-wide log, minus the Manager column
// and its filter.
function renderSwapLog(containerId = 'swap-log-list', editable = isLoggedInCommissioner(), scopeManager = null) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const emailMap = (DATA && DATA.email_map) || {};
  const managerOf = (s) => s.manager || emailMap[s.email] || s.email || '';
  let allSwaps = [...getSeasonSwaps(sd)];

  const state = getSwapLogState(containerId);
  state.editable = editable;
  state.scopeManager = scopeManager;
  if (scopeManager) allSwaps = allSwaps.filter((s) => managerOf(s) === scopeManager);

  if (allSwaps.length === 0) {
    container.innerHTML = `<p class="text-muted">${scopeManager ? 'No swaps recorded.' : 'No swap history yet.'}</p>`;
    return;
  }

  // Most recent first
  allSwaps.sort((a, b) => {
    const ta = a.timestamp || a.swap_date || '';
    const tb = b.timestamp || b.swap_date || '';
    return tb.localeCompare(ta);
  });

  // Available filter values from the full swap set.
  const allManagers = [...new Set(allSwaps.map(managerOf).filter(Boolean))].sort();
  const allTypes = [...new Set(allSwaps.map((s) => s.reason || SWAP_NO_REASON_LABEL))].sort();

  // Drop a saved selection that no longer matches any swap (e.g. after a season switch).
  if (state.manager && !allManagers.includes(state.manager)) state.manager = '';
  if (state.type && !allTypes.includes(state.type)) state.type = '';

  const typeOf = (s) => s.reason || SWAP_NO_REASON_LABEL;
  const filtered = allSwaps.filter(
    (s) => (!state.manager || managerOf(s) === state.manager) && (!state.type || typeOf(s) === state.type)
  );

  let html = '<div class="swap-log-filters">';
  if (!scopeManager) {
    html += swapFilterSelectHtml(containerId, 'Manager', 'manager', allManagers, state.manager, 'All managers');
  }
  html += swapFilterSelectHtml(containerId, 'Type', 'type', allTypes, state.type, 'All types');
  html += '</div>';

  if (filtered.length === 0) {
    html += '<p class="text-muted">No swaps match the current filters.</p>';
    container.innerHTML = html;
    return;
  }

  const cols = scopeManager ? 6 : 7;
  html +=
    '<table class="data-table swap-log-table"><thead><tr><th style="width:1.5rem;"></th>' +
    (scopeManager ? '' : '<th>Manager</th>') +
    '<th>Out</th><th>In</th><th>Date</th><th>Status</th><th>Reason</th></tr></thead><tbody>';
  filtered.forEach((s) => {
    const date = serverTimestampLocalDate(s.timestamp) || s.swap_date || '';
    const outTxt = displayPlayer(s.player_out || '—', sd);
    const inTxt = displayPlayer(s.player_in || '—', sd);
    const reason = s.reason || '';
    const isOpen = state.expanded.has(s.id);
    let reasonCell;
    if (editable) {
      const opts = COMMISSIONER_SWAP_REASONS.map(
        (r) => `<option value="${esc(r)}"${r === reason ? ' selected' : ''}>${esc(swapReasonLabel(r))}</option>`
      ).join('');
      reasonCell = `<select onclick="event.stopPropagation()" onchange="saveSwapLogReason('${containerId}','${s.id}', this.value)" style="font-size:0.82rem;color:var(--text-muted);border:1px solid transparent;background:transparent;cursor:pointer;padding:2px 4px;border-radius:4px;" onmouseover="this.style.borderColor='var(--border)'" onmouseout="this.style.borderColor='transparent'">${opts}</select>`;
    } else {
      reasonCell = esc(swapReasonLabel(reason));
    }
    html += `<tr class="swap-log-row${isOpen ? ' swap-log-row-open' : ''}" onclick="toggleSwapDetail('${containerId}','${s.id}')">
      <td class="swap-log-caret">${isOpen ? '▾' : '▸'}</td>
      ${scopeManager ? '' : `<td>${esc(managerOf(s) || '—')}</td>`}
      <td>${outTxt}</td>
      <td>${inTxt}</td>
      <td style="white-space:nowrap;font-size:0.82rem;">${date}</td>
      <td>${swapStatusBadge(s)}</td>
      <td style="font-size:0.82rem;color:var(--text-muted);">${reasonCell}</td>
    </tr>`;
    html += `<tr class="swap-log-detail-row" id="swap-detail-${containerId}-${s.id}" style="display:${isOpen ? '' : 'none'};">
      <td colspan="${cols}">${swapDetailHtml(s, sd, containerId, editable)}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

// Toggle the detail panel for a single swap row.
window.toggleSwapDetail = function (containerId, swapId) {
  const state = getSwapLogState(containerId);
  const detailRow = document.getElementById(`swap-detail-${containerId}-${swapId}`);
  if (!detailRow) return;
  const open = detailRow.style.display === 'none';
  detailRow.style.display = open ? '' : 'none';
  if (open) state.expanded.add(swapId);
  else state.expanded.delete(swapId);
  // Update the caret + row highlight on the summary row.
  const summaryRow = detailRow.previousElementSibling;
  if (summaryRow) {
    summaryRow.classList.toggle('swap-log-row-open', open);
    const caret = summaryRow.querySelector('.swap-log-caret');
    if (caret) caret.textContent = open ? '▾' : '▸';
  }
};

// Set a filter dropdown ('' = All), then re-render the affected log.
window.swapLogSetFilter = function (containerId, kind, value) {
  const state = getSwapLogState(containerId);
  if (kind === 'manager') state.manager = value;
  else state.type = value;
  renderSwapLog(containerId, state.editable, state.scopeManager);
};

window.saveSwapLogReason = async function (containerId, swapId, newReason) {
  const result = await persistSwapMutation(SELECTED_SEASON, swapId, 'PUT', '', { reason: newReason });
  if (!result) return;
  const state = getSwapLogState(containerId);
  renderSwapLog(containerId, state.editable, state.scopeManager);
};

// Commissioner: edit a swap's drop/add date from the Swap Log detail panel. Changing the add
// date also moves the informational effective date (they are equal by construction). On an
// approved swap the server re-applies the roster windows and recomputes scores, so pull the
// authoritative season down afterwards (same pattern as the auto-apply submission flow).
window.saveSwapLogDate = async function (containerId, swapId, field, value) {
  const state = getSwapLogState(containerId);
  if (!value) {
    renderSwapLog(containerId, state.editable, state.scopeManager); // restore the old value in the input
    return;
  }
  const body = { [field]: value };
  if (field === 'add_date') body.effective_date = value;
  const result = await persistSwapMutation(SELECTED_SEASON, swapId, 'PUT', '', body);
  if (result) await refreshSeasonsFromServer();
  renderSwapLog(containerId, state.editable, state.scopeManager);
};

// ---- Manager: change or cancel a swap that hasn't taken effect yet ----
// The server owns the rules (swapModifyGuard: your own swap, still scheduled); these handlers just
// drive the inline form in the swap-log detail panel and refresh the views the change moves.

window.toggleScheduledSwapEdit = function (editId) {
  const el = document.getElementById(editId);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// Pull the authoritative season down after a swap mutation: the server re-applies the roster
// windows and recomputes scores, so the local copy is stale until we re-fetch (same pattern as
// the auto-apply submission and commissioner approve flows).
async function refreshSeasonsFromServer() {
  try {
    const fresh = await fetch('/api/seasons');
    if (fresh.ok) {
      const srv = await fresh.json();
      if (srv && Object.keys(srv).length > 0) setSeasonsLocal(srv);
    }
  } catch (_) {
    /* offline — local view may lag until reload */
  }
}

// Re-render whatever swap log the action came from plus the roster page beneath it, so the
// per-week tables and the swap row both reflect the change without a reload.
function refreshAfterSwapChange(containerId) {
  const state = getSwapLogState(containerId);
  renderSwapLog(containerId, state.editable, state.scopeManager);
  const me = findManagerByEmail(LOGGED_IN_EMAIL || '');
  if (me && document.getElementById('roster-content')) renderRosterData(me.name, isLoggedInCommissioner());
  if (document.getElementById('swap-log-public')) renderSwapLog('swap-log-public', false);
}

window.saveScheduledSwap = async function (containerId, swapId) {
  const editId = `sched-edit-${containerId}-${swapId}`;
  const dateEl = document.getElementById(`${editId}-date`);
  const reasonEl = document.getElementById(`${editId}-reason`);
  const errEl = document.getElementById(`${editId}-error`);
  const showErr = (msg) => {
    if (!errEl) return alert(msg);
    errEl.textContent = msg;
    errEl.style.display = 'block';
  };
  if (errEl) errEl.style.display = 'none';

  const body = {};
  if (dateEl && dateEl.value) body.add_date = dateEl.value;
  if (reasonEl && reasonEl.value) body.reason = reasonEl.value;
  if (!Object.keys(body).length) return;
  // Mirror the server's forward-only rule so the common mistake gets an answer without a round trip.
  if (body.add_date && body.add_date <= isoDateET(new Date())) {
    return showErr(
      'A scheduled swap must stay in the future. To apply it right away, cancel it and submit a new swap effective today.'
    );
  }

  const result = await persistSwapMutation(SELECTED_SEASON, swapId, 'PUT', '', body, showErr);
  if (!result) return;
  await refreshSeasonsFromServer();
  refreshAfterSwapChange(containerId);
};

window.cancelScheduledSwap = async function (containerId, swapId) {
  const sd = getSeasons()[SELECTED_SEASON];
  const swap = ((sd && sd.swaps) || []).find((s) => String(s.id) === String(swapId));
  if (!swap) return;
  if (
    !confirm(
      `Cancel this scheduled swap? ${swap.player_out} stays on your roster, ${swap.player_in} is removed, ` +
        'and the swap goes back into your allotment for this round.'
    )
  ) {
    return;
  }
  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/swaps/${swapId}/undo`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(err.detail || err.error || `Cancel failed (${resp.status}). Please reload and try again.`);
      return;
    }
  } catch (e) {
    alert(`Cancel failed — ${e.message}. Please reload and try again.`);
    return;
  }
  await refreshSeasonsFromServer();
  refreshAfterSwapChange(containerId);
};

// ---- MLB API Sync Log (Commissioner Tab: Stats Data) ----
function renderMLBSyncLog() {
  const controlsDiv = document.getElementById('mlb-sync-controls');
  const logDiv = document.getElementById('mlb-sync-log');
  if (!controlsDiv) return;

  // "Sync Now" stays primary; the recovery/diagnostic tools live behind a collapsible
  // "Diagnostics" toggle so the commissioner page isn't cluttered with rarely-used controls.
  controlsDiv.innerHTML =
    `<button class="btn btn-secondary" onclick="triggerMLBSync()">Sync Now</button>` +
    `<button class="btn btn-sm btn-secondary" style="margin-left:0.5rem;font-size:0.78rem;" ` +
    `onclick="const d=document.getElementById('mlb-diag-tools');d.style.display=d.style.display==='none'?'flex':'none';">` +
    `Diagnostics ▾</button>` +
    `<div id="mlb-diag-tools" style="display:none;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-top:0.5rem;">` +
    `<button class="btn btn-sm btn-secondary" onclick="backfillMLB()">Backfill from MLB</button>` +
    `<button class="btn btn-sm btn-secondary" onclick="rebuildMLBWeeklies()">Rebuild Totals</button>` +
    `<button class="btn btn-sm btn-secondary" onclick="dataCheckMLB()">Data check</button>` +
    `<button class="btn btn-sm btn-secondary" onclick="storageCheckMLB()">Storage</button>` +
    `<span style="display:inline-flex;gap:0.35rem;align-items:center;">` +
    `<input id="mlb-debug-name" type="text" placeholder="Player name" ` +
    `style="font-size:0.82rem;padding:0.2rem 0.4rem;" onkeydown="if(event.key==='Enter')debugMLBPlayer()" />` +
    `<button class="btn btn-sm btn-secondary" onclick="debugMLBPlayer()">Debug player</button>` +
    `</span></div><div id="mlb-debug-out"></div>`;

  apiFetch('/api/mlb/sync-status')
    .then((r) => r.json())
    .then((s) => {
      const nextDate = s.next_sync ? new Date(s.next_sync) : null;
      if (nextDate) {
        controlsDiv.innerHTML += `<span style="font-size:0.82rem;color:var(--text-muted,#666);margin-left:0.75rem;">Next auto-sync: ${nextDate.toLocaleString()}</span>`;
      }

      if (!logDiv) return;
      const logs = s.recent_logs || [];
      if (logs.length === 0) {
        logDiv.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">No sync runs recorded yet.</p>';
        return;
      }

      // Badge an entry by how it was triggered (auto vs manual) and what kind of run it was.
      const autoStyle = 'background:#0ea5e9;color:#fff;';
      const correctionStyle = 'background:var(--accent,#6c63ff);color:#fff;';
      const manualStyle = 'background:var(--secondary,#555);color:#fff;';
      const badgeFor = (l) => {
        const note = l.note || '';
        // Older entries pre-date the `trigger` field; fall back to the audit type.
        const isAuto = l.trigger ? l.trigger === 'auto' : l.type === 'mlbapi_auto_sync';
        if (note.startsWith('daily-delta')) return { label: 'Daily', style: autoStyle };
        if (note.startsWith('wed-correction') || note.startsWith('catchup')) {
          return { label: 'Correction', style: correctionStyle };
        }
        if (note.startsWith('startup-backfill')) return { label: 'Backfill', style: correctionStyle };
        if (isAuto) return { label: 'Auto', style: autoStyle };
        return { label: 'Manual', style: manualStyle };
      };

      // Group entries by week, newest week on top (by schedule order), newest run first within a week.
      const groups = new Map();
      logs.forEach((l) => {
        const round = l.round || '';
        const week = l.week || '';
        const key = `${round}||${week}`;
        if (!groups.has(key)) {
          const idx = SEASON_SCHEDULE.findIndex((sc) => sc.round === round && sc.week === week);
          groups.set(key, { round, week, idx, entries: [] });
        }
        groups.get(key).entries.push(l);
      });
      const orderedGroups = [...groups.values()].sort((a, b) => b.idx - a.idx);
      orderedGroups.forEach((g) => g.entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))));

      let logHtml = `<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
        <h3 style="margin:0;">Sync Log</h3>
        <button class="btn btn-sm btn-secondary" onclick="const e=document.getElementById('mlb-log-entries');e.style.display=e.style.display==='none'?'block':'none';this.textContent=this.textContent==='Show'?'Hide':'Show';" style="font-size:0.75rem;padding:0.15rem 0.5rem;">Show</button>
      </div><div id="mlb-log-entries" style="display:none;" class="gsheets-log-list">`;

      orderedGroups.forEach((g) => {
        const weekLabel = `${esc(g.round)} ${esc(g.week)}`.trim() || 'Unknown week';
        logHtml += `<div style="margin-top:0.5rem;font-weight:600;font-size:0.8rem;">${weekLabel}</div>`;
        g.entries.forEach((l) => {
          const note = l.note || '';
          const b = badgeFor(l);
          const noteLabel = note.startsWith('catchup-')
            ? ` (${note.slice(8)})`
            : note.startsWith('wed-correction:')
              ? ` (${note.slice(15)})`
              : '';
          const detail = `${l.batting_imported ?? '?'} batting, ${l.pitching_imported ?? '?'} pitching (${l.games ?? '?'} games)${noteLabel}`;
          logHtml += `<div class="gsheets-log-item">
            <span class="gsheets-log-time">${fmtServerTimestamp(l.timestamp)}</span>
            <span class="swap-badge" style="${b.style}font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:4px;">${b.label}</span>
            <span style="font-size:0.82rem;color:var(--text-muted,#666);">${detail}</span>
          </div>`;
        });
      });
      logHtml += '</div>';
      logDiv.innerHTML = logHtml;
    })
    .catch(() => {
      if (logDiv) logDiv.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Could not load sync log.</p>';
    });
}

window.triggerMLBSync = function () {
  const btn = document.querySelector('#mlb-sync-controls .btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  apiFetch('/api/mlb/sync-current', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: SELECTED_SEASON }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.error) {
        alert(`Sync failed: ${res.error}`);
      } else {
        syncFromServer().then(() => {
          init();
          renderMLBSyncLog();
        });
      }
    })
    .catch((e) => alert(`Sync error: ${e.message}`))
    .finally(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Sync Now';
      }
    });
};

// Re-fetch every elapsed week from the MLB Stats API to restore missing stored stats.
window.backfillMLB = function () {
  if (
    !confirm(
      'Re-fetch all elapsed weeks from the MLB Stats API? This restores missing stats; it is idempotent and preserves manual edits. May take a minute.'
    )
  ) {
    return;
  }
  const out = document.getElementById('mlb-debug-out');
  if (out) {
    out.innerHTML =
      '<p class="text-muted" style="font-size:0.82rem;">Backfilling from MLB… (this can take a minute)</p>';
  }
  apiFetch('/api/mlb/backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: SELECTED_SEASON }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.error) {
        if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(res.error)}</p>`;
        return;
      }
      syncFromServer().then(() => {
        init();
        renderMLBSyncLog();
        const o = document.getElementById('mlb-debug-out');
        if (o) {
          const warn =
            res.backup && res.backup.ok === false && !res.backup.skipped
              ? `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">⚠ Upstash backup did NOT persist (${res.backup.bytes} bytes, status ${res.backup.status}). Data may be lost on the next restart — likely a backup size limit.</p>`
              : '';
          o.innerHTML =
            warn +
            `<pre style="font-size:0.72rem;max-height:420px;overflow:auto;background:var(--bg-alt,#f5f5f5);padding:0.5rem;border-radius:4px;white-space:pre-wrap;">${esc(
              JSON.stringify(res, null, 2)
            )}</pre>`;
        }
      });
    })
    .catch((e) => {
      if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(e.message)}</p>`;
    });
};

// Read-only: where db.json is persisted and whether durable storage is actually active.
window.storageCheckMLB = function () {
  const out = document.getElementById('mlb-debug-out');
  if (out) out.innerHTML = '<p class="text-muted" style="font-size:0.82rem;">Loading…</p>';
  apiFetch('/api/mlb/storage-status')
    .then((r) => r.json())
    .then((res) => {
      if (!out) return;
      if (res.error) {
        out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(res.error)}</p>`;
        return;
      }
      const warn = res.warning
        ? `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">⚠ ${esc(res.warning)}</p>`
        : '<p style="font-size:0.82rem;color:var(--success,#2e7d32);">✓ Durable storage is active.</p>';
      out.innerHTML =
        warn +
        `<pre style="font-size:0.72rem;max-height:420px;overflow:auto;background:var(--bg-alt,#f5f5f5);padding:0.5rem;border-radius:4px;white-space:pre-wrap;">${esc(
          JSON.stringify(res, null, 2)
        )}</pre>`;
    })
    .catch((e) => {
      if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(e.message)}</p>`;
    });
};

// Read-only season-wide data check: per-week stored daily/weekly counts + attribution.
window.dataCheckMLB = function () {
  const out = document.getElementById('mlb-debug-out');
  if (out) out.innerHTML = '<p class="text-muted" style="font-size:0.82rem;">Loading…</p>';
  apiFetch(`/api/mlb/data-debug?year=${encodeURIComponent(SELECTED_SEASON)}`)
    .then((r) => r.json())
    .then((res) => {
      if (!out) return;
      if (res.error) {
        out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(res.error)}</p>`;
        return;
      }
      out.innerHTML = `<pre style="font-size:0.72rem;max-height:420px;overflow:auto;background:var(--bg-alt,#f5f5f5);padding:0.5rem;border-radius:4px;white-space:pre-wrap;">${esc(
        JSON.stringify(res, null, 2)
      )}</pre>`;
    })
    .catch((e) => {
      if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(e.message)}</p>`;
    });
};

// Rebuild weekly totals from stored daily data and re-attribute from current rosters.
window.rebuildMLBWeeklies = function () {
  if (
    !confirm(
      'Rebuild all weekly totals from stored daily stats and re-attribute to current rosters? This does not re-fetch from MLB and preserves manual edits.'
    )
  ) {
    return;
  }
  const out = document.getElementById('mlb-debug-out');
  if (out) out.innerHTML = '<p class="text-muted" style="font-size:0.82rem;">Rebuilding…</p>';
  apiFetch('/api/mlb/rebuild-weeklies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: SELECTED_SEASON }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.error) {
        if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(res.error)}</p>`;
        return;
      }
      syncFromServer().then(() => {
        init();
        renderMLBSyncLog();
        const o = document.getElementById('mlb-debug-out');
        if (o) {
          o.innerHTML = `<pre style="font-size:0.72rem;max-height:420px;overflow:auto;background:var(--bg-alt,#f5f5f5);padding:0.5rem;border-radius:4px;white-space:pre-wrap;">${esc(
            JSON.stringify(res.results, null, 2)
          )}</pre>`;
        }
      });
    })
    .catch((e) => {
      if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(e.message)}</p>`;
    });
};

// Read-only diagnostic: dump everything that determines a player's displayed points.
window.debugMLBPlayer = function () {
  const out = document.getElementById('mlb-debug-out');
  const name = (document.getElementById('mlb-debug-name') || {}).value;
  if (!name || !name.trim()) {
    if (out) out.innerHTML = '<p class="text-muted" style="font-size:0.82rem;">Enter a player name first.</p>';
    return;
  }
  if (out) out.innerHTML = '<p class="text-muted" style="font-size:0.82rem;">Loading…</p>';
  apiFetch(`/api/mlb/player-debug?year=${encodeURIComponent(SELECTED_SEASON)}&name=${encodeURIComponent(name.trim())}`)
    .then((r) => r.json())
    .then((res) => {
      if (!out) return;
      if (res.error) {
        out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(res.error)}</p>`;
        return;
      }
      out.innerHTML = `<pre style="font-size:0.72rem;max-height:420px;overflow:auto;background:var(--bg-alt,#f5f5f5);padding:0.5rem;border-radius:4px;white-space:pre-wrap;">${esc(
        JSON.stringify(res, null, 2)
      )}</pre>`;
    })
    .catch((e) => {
      if (out) out.innerHTML = `<p style="font-size:0.82rem;color:var(--danger,#c0392b);">${esc(e.message)}</p>`;
    });
};

// ---- Pending Swap Requests (Commissioner Tab) ----
function renderPendingSwapRequests() {
  const container = document.getElementById('pending-swaps-list');
  if (!container) return;

  // The to-do card counts the same pending items — keep it in step with every
  // re-render of this list (approve/deny actions included).
  renderCommissionerTodo();

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) {
    container.innerHTML = '<p class="text-muted">No pending requests.</p>';
    return;
  }

  let html = '';

  // Pending roster submissions — PP1 (initial_submissions) + other periods
  const managers = getManagers();
  const allPeriods = [
    {
      period: 'pp1',
      label: 'Pool Play 1',
      approveFn: 'approveInitialSubmission',
      denyFn: 'denyInitialSubmission',
      editFn: 'editInitialSubmissionComm',
      deleteFn: 'deleteInitialSubmission',
      isLegacy: true,
    },
    { period: 'pp2', label: 'Pool Play 2', isLegacy: false },
    { period: 'qf', label: 'Quarterfinals', isLegacy: false },
    { period: 'sf', label: 'Semifinals', isLegacy: false },
    { period: 'finals', label: 'Finals', isLegacy: false },
  ];

  for (const { period, label, isLegacy, approveFn, denyFn, editFn, deleteFn } of allPeriods) {
    managers
      .filter((m) => {
        const sub = getPeriodSub(sd, period, m.name);
        return sub && sub.status === 'pending';
      })
      .forEach((m) => {
        const sub = getPeriodSub(sd, period, m.name);
        const safeName = jsStr(m.name);
        const idSafe = m.name.replace(/\s+/g, '-');
        if (isLegacy) {
          html += `<div class="swap-pending-item" id="comm-init-item-${idSafe}">
          <div class="swap-pending-header">
            <strong>${esc(m.name)}</strong>
            <span class="swap-badge" style="background:var(--primary);color:#fff;">${label}</span>
            <span class="swap-badge swap-badge-pending">Pending</span>
          </div>
          <div class="swap-pending-details" style="flex-direction:column;align-items:flex-start;gap:0.15rem;">
            <span><strong>Batters:</strong> ${(sub.batters || []).map((b) => displayPlayer(b, sd)).join(', ') || 'None'}</span>
            <span><strong>Pitchers:</strong> ${(sub.pitchers || []).map((p) => displayPlayer(p, sd)).join(', ') || 'None'}</span>
          </div>
          <div id="comm-initial-edit-${idSafe}" style="display:none;"></div>
          ${buildForgivenessControls(period, m.name, sub)}
          <div class="swap-pending-actions">
            <button class="btn btn-sm btn-success" onclick="${approveFn}('${safeName}')">Approve</button>
            <button class="btn btn-sm btn-secondary" onclick="${editFn}('${safeName}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="${denyFn}('${safeName}')">Deny</button>
            <button class="btn btn-sm btn-danger" onclick="${deleteFn}('${safeName}')">Delete</button>
            <button class="btn btn-sm btn-secondary" onclick="viewSwapManager('${safeName}')">View Roster</button>
          </div>
        </div>`;
        } else {
          html += `<div class="swap-pending-item">
          <div class="swap-pending-header">
            <strong>${esc(m.name)}</strong>
            <span class="swap-badge" style="background:var(--primary);color:#fff;">${label}</span>
            <span class="swap-badge swap-badge-pending">Pending</span>
          </div>
          <div class="swap-pending-details" style="flex-direction:column;align-items:flex-start;gap:0.15rem;">
            <span><strong>Batters:</strong> ${(sub.batters || []).map((b) => displayPlayer(b, sd)).join(', ') || 'None'}</span>
            <span><strong>Pitchers:</strong> ${(sub.pitchers || []).map((p) => displayPlayer(p, sd)).join(', ') || 'None'}</span>
          </div>
          ${buildForgivenessControls(period, m.name, sub)}
          <div class="swap-pending-actions">
            <button class="btn btn-sm btn-success" onclick="approvePeriodSubmission('${period}','${safeName}')">Approve</button>
            <button class="btn btn-sm btn-danger" onclick="denyPeriodSubmission('${period}','${safeName}')">Deny</button>
            <button class="btn btn-sm btn-danger" onclick="deletePeriodSubmission('${period}','${safeName}')">Delete</button>
            <button class="btn btn-sm btn-secondary" onclick="viewSwapManager('${safeName}')">View Roster</button>
          </div>
        </div>`;
        }
      });
  }

  // Pending in-season swaps
  const pendingSwaps = (sd.swaps || []).filter((s) => s.status === 'pending');
  if (pendingSwaps.length > 0) {
    const _today = new Date().toISOString().split('T')[0];
    const _tomorrow = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    })();
    pendingSwaps.forEach((s) => {
      html += `<div class="swap-pending-item" id="comm-swap-item-${s.id}">
        <div class="swap-pending-header">
          <strong>${esc(s.manager || 'Unknown')}</strong>
          <span class="swap-badge swap-badge-pending">Swap Pending</span>
        </div>
        <div class="swap-pending-details">
          <span>${displayPlayer(s.player_out || '?', sd)} &rarr; ${displayPlayer(s.player_in || '?', sd)}</span>
          <span class="swap-detail-reason">${esc(s.reason || '')}</span>
          <span class="swap-detail-date">${s.swap_date || ''}</span>
        </div>
        <div class="swap-effective-dates">
          <span class="swap-effective-label">Swap Effective Date</span>
          <div class="swap-date-fields">
            <div class="swap-date-field">
              <label>Drop Date (${esc(s.player_out || '?')})</label>
              <input type="date" id="comm-drop-date-${s.id}" class="form-input swap-date-input" value="${s.drop_date || _today}"
                onchange="syncSwapAddDate('comm-drop-date-${s.id}','comm-add-date-${s.id}')">
            </div>
            <div class="swap-date-field">
              <label>Add Date (${esc(s.player_in || '?')})</label>
              <input type="date" id="comm-add-date-${s.id}" class="form-input swap-date-input" value="${s.add_date || _tomorrow}">
            </div>
          </div>
        </div>
        <div class="swap-pending-actions" id="comm-swap-actions-${s.id}">
          <button class="btn btn-sm btn-success" onclick="approveSwap('${s.id}')">Approve</button>
          <button class="btn btn-sm btn-danger" onclick="denySwap('${s.id}')">Deny</button>
          <button class="btn btn-sm btn-secondary" onclick="viewSwapManager('${jsStr(s.manager || '')}')">View Roster</button>
        </div>
      </div>`;
    });
  }

  if (!html) {
    container.innerHTML = '<p class="text-muted">No pending requests.</p>';
    return;
  }

  container.innerHTML = html;
  // The late-submission rows in this queue (buildForgivenessControls) need the server's window —
  // its period bounds are the min/max on the commissioner's back-date picker. Fetched after the
  // paint, re-rendering only if an answer moved.
  refreshSubmissionWindows(['pp1', 'pp2', 'qf', 'sf', 'finals'], renderPendingSwapRequests);
}

// Navigate to a manager's roster page from commissioner pending swaps
window.viewSwapManager = function (managerName) {
  // Switch to My Roster tab and select this manager
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
  document.querySelector('[data-tab="my-roster"]').classList.add('active');
  document.getElementById('my-roster').classList.add('active');

  // Build/populate the roster dropdown, then switch it to the requested manager.
  setupMyRoster();
  const dd = document.getElementById('roster-manager-dropdown');
  if (dd && dd._dd) dd._dd.setValue(managerName, true);
};

// ---- Season Setup Toggle ----
function setupSeasonSetupToggle() {
  const toggle = document.getElementById('season-setup-toggle');
  const body = document.getElementById('season-setup-body');
  const btn = document.getElementById('season-setup-toggle-btn');
  if (!toggle || !body || !btn) return;

  toggle.onclick = () => {
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    btn.textContent = isHidden ? 'Hide' : 'Show';
  };

  // Create New Season button
  const createBtn = document.getElementById('create-new-season-btn');
  const createStatus = document.getElementById('create-new-season-status');
  if (createBtn) {
    createBtn.onclick = () => {
      const seasons = getSeasons();
      const existingYears = Object.keys(seasons)
        .map(Number)
        .sort((a, b) => b - a);
      const latestYear = existingYears.length > 0 ? existingYears[0] : CURRENT_YEAR;
      const newYear = latestYear + 1;

      if (seasons[newYear]) {
        if (createStatus) {
          createStatus.innerHTML = `<p style="color:var(--success);">Season ${newYear} already exists.</p>`;
        }
        return;
      }

      const confirmed = confirm(
        `Create a new ${newYear} season?\n\n` +
          'This will:\n' +
          '  - Create a fresh season for ' +
          newYear +
          '\n' +
          '  - Carry forward all manager accounts and pool assignments\n' +
          '  - Start with empty player pools, rosters, and stats\n\n' +
          'The current season will not be affected.'
      );
      if (!confirmed) return;

      // Build the new season — managers carry forward (pool assignments preserved)
      seasons[newYear] = {
        status: 'active',
        batters_pool: [],
        pitchers_pool: [],
        weekly_batting: [],
        weekly_pitching: [],
        rosters: {},
        swaps: [],
        upload_log: [],
        team_weekly: [],
        initial_submissions: {},
        period_submissions: { pp2: {}, qf: {}, sf: {}, finals: {} },
      };

      // Pre-populate rosters map for each manager (empty, but keyed)
      const managers = getManagers();
      managers.forEach((m) => {
        seasons[newYear].rosters[m.name] = {};
        seasons[newYear].initial_submissions[m.name] = { batters: [], pitchers: [], status: 'draft' };
        for (const p of ['pp2', 'qf', 'sf', 'finals']) {
          seasons[newYear].period_submissions[p][m.name] = { batters: [], pitchers: [], status: 'draft' };
        }
      });

      setSeasonsLocal(seasons);
      apiFetch('/api/seasons/' + newYear, {
        method: 'POST',
        body: JSON.stringify(seasons[newYear]),
      }).catch(() => {});

      if (createStatus) {
        createStatus.innerHTML = `<p style="color:var(--success);font-weight:600;">Season ${newYear} created! Switch to it using the season selector in the header.</p>`;
      }

      // Refresh the season selector
      buildSeasonSelector();
    };
  }

  // Reset Season button
  const resetBtn = document.getElementById('reset-season-btn');
  const resetStatus = document.getElementById('reset-season-status');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      const confirmed = confirm(
        `Are you sure you want to reset all season data for ${SELECTED_SEASON}?\n\n` +
          'This will clear:\n' +
          '  - All player pools (batters & pitchers)\n' +
          '  - All initial player submissions\n' +
          '  - All rosters\n' +
          '  - All uploaded weekly stats\n' +
          '  - All swap history\n\n' +
          'Manager names, emails, pool assignments, and credentials will NOT be affected.\n\n' +
          'This action cannot be undone.'
      );
      if (!confirmed) return;

      const seasons = getSeasons();
      const sd = seasons[SELECTED_SEASON];
      if (!sd) return;

      sd.batters_pool = [];
      sd.pitchers_pool = [];
      sd.weekly_batting = [];
      sd.weekly_pitching = [];
      sd.rosters = {};
      sd.team_weekly = [];
      sd.swaps = [];
      sd.upload_log = [];
      sd.initial_submissions = {};
      sd.period_submissions = { pp2: {}, qf: {}, sf: {}, finals: {} };

      saveSeason(SELECTED_SEASON, sd);
      // Submissions are server-authoritative on the full save, so clear them via their
      // dedicated endpoint too (best-effort) — otherwise the reload would restore them.
      await apiFetch(`/api/seasons/${SELECTED_SEASON}/submissions`, { method: 'DELETE' }).catch(() => {});
      if (resetStatus) {
        resetStatus.innerHTML = '<p style="color:var(--success);font-weight:600;">Season data has been reset.</p>';
      }
      init();
    };
  }
}

// ---- ASG Date Input ----
function setupASGDateInput() {
  const input = document.getElementById('asg-date-input');
  const btn = document.getElementById('asg-date-save-btn');
  const status = document.getElementById('asg-date-status');
  if (!input || !btn) return;

  // Pre-fill if already saved
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (sd && sd.asg_date) {
    input.value = sd.asg_date;
  }
  renderScheduleDatesPreview();

  btn.onclick = () => {
    if (!input.value) {
      status.innerHTML = '<span style="color:#ef4444;">Please select a date.</span>';
      return;
    }
    const dates = computeScheduleDates(input.value);
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    sd.asg_date = input.value;
    sd.schedule_dates = dates;
    setSeasonsLocal(seasons);
    saveSchedule(SELECTED_SEASON, { schedule_dates: dates, asg_date: input.value });

    status.innerHTML = '<span style="color:#10b981;">Schedule dates saved!</span>';
    renderScheduleDatesPreview();
    // Refresh dependent views
    renderWeeklyUploadSections();
  };
}

// Per-period defaults: earliest MLB game found on each WMMC start date for the 2026 season
// (ASG = July 14 2026 → PP1 starts May 4, PP2 June 8, QF July 20, SF Aug 3, Finals Aug 17)
function setupPeriodDeadlineInputs() {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];

  const toLocalInputVal = (isoStr) => {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const fmtDeadline = (isoStr) => {
    if (!isoStr) return '—';
    const d = new Date(new Date(isoStr).getTime() - 5 * 60 * 1000);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  for (const [period, defaultVal] of Object.entries(PERIOD_DEADLINE_DEFAULTS)) {
    const inputEl = document.getElementById(`period-deadline-input-${period}`);
    const btnEl = document.getElementById(`period-deadline-save-${period}`);
    const statusEl = document.getElementById(`period-deadline-status-${period}`);
    if (!inputEl || !btnEl) continue;

    const stored = sd && sd.period_deadlines && sd.period_deadlines[period];
    inputEl.value = stored ? toLocalInputVal(stored) : defaultVal;

    btnEl.onclick = () => {
      if (!inputEl.value) {
        statusEl.innerHTML = '<span style="color:#ef4444;">Please select a date and time.</span>';
        return;
      }
      const gameTime = new Date(inputEl.value);
      if (isNaN(gameTime.getTime())) {
        statusEl.innerHTML = '<span style="color:#ef4444;">Invalid date/time.</span>';
        return;
      }
      const seasons2 = getSeasons();
      const sd2 = seasons2[SELECTED_SEASON];
      if (!sd2.period_deadlines) sd2.period_deadlines = {};
      sd2.period_deadlines[period] = gameTime.toISOString();
      saveSeason(SELECTED_SEASON, sd2);
      statusEl.innerHTML = `<span style="color:#10b981;">Saved! Managers can submit until <strong>${fmtDeadline(gameTime.toISOString())}</strong>.</span>`;
    };
  }
}

async function autoFillSchedule() {
  const statusEl = document.getElementById('autofill-schedule-status');
  const btn = document.getElementById('autofill-schedule-btn');
  if (!btn || !statusEl) return;

  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:#888;">Fetching MLB schedule data…</span>';

  const season = SELECTED_SEASON || String(new Date().getFullYear());
  const results = [];
  const warnings = [];

  // Helper: convert a datetime-local string to toLocalInputVal format
  const toLocalInputVal = (isoStr) => {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  // Helper: fetch JSON from MLB Stats API, returns null on any failure
  const mlbFetch = async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      return null;
    }
  };

  // Step 1: detect ASG date
  let asgDate = null;
  const asgData = await mlbFetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameTypes=A&season=${season}`);
  if (asgData && asgData.dates) {
    for (const dateEntry of asgData.dates) {
      if ((dateEntry.games || []).some((g) => g.gameType === 'A')) {
        asgDate = dateEntry.date;
        break;
      }
    }
  }
  if (asgDate) {
    results.push(`All-Star Game: <strong>${asgDate}</strong> (from MLB API)`);
  } else {
    const asgInput = document.getElementById('asg-date-input');
    if (asgInput && asgInput.value) {
      asgDate = asgInput.value;
      results.push(`All-Star Game: <strong>${asgDate}</strong> (from current input — API unavailable)`);
    } else if (season === '2026') {
      asgDate = '2026-07-14';
      warnings.push('MLB API unavailable; using 2026 ASG default (July 14). Confirm before saving.');
      results.push(`All-Star Game: <strong>${asgDate}</strong> (2026 default)`);
    } else {
      btn.disabled = false;
      statusEl.innerHTML =
        '<span style="color:#ef4444;">Could not determine ASG date from the MLB API. Please enter it manually first.</span>';
      return;
    }
  }

  // Step 2: compute WMMC schedule from ASG date
  const schedDates = computeScheduleDates(asgDate);

  // period → SEASON_SCHEDULE index of that period's Week 1
  const periodToIdx = { pp1: 0, pp2: 5, qf: 10, sf: 12, finals: 14 };
  const periodDeadlines = {};

  // Step 3: fetch earliest game time for each period's first date
  for (const [period, idx] of Object.entries(periodToIdx)) {
    const dateStr = schedDates[idx] && schedDates[idx].start;
    if (!dateStr) {
      warnings.push(`Could not determine date for ${PERIOD_LABELS[period]}.`);
      continue;
    }

    let gameTime = null;
    const dayData = await mlbFetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&timeZone=America/New_York`
    );
    if (dayData && dayData.dates && dayData.dates[0]) {
      const games = (dayData.dates[0].games || [])
        .filter((g) => g.gameDate)
        .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
      if (games.length > 0) {
        gameTime = games[0].gameDate;
        const localFmt = new Date(gameTime).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/New_York',
        });
        results.push(`${PERIOD_LABELS[period]}: <strong>${dateStr}</strong> — earliest game ${localFmt} ET (API)`);
      }
    }

    if (!gameTime) {
      const def = PERIOD_DEADLINE_DEFAULTS[period];
      if (def) {
        gameTime = new Date(def).toISOString();
        warnings.push(
          `${PERIOD_LABELS[period]}: MLB API unavailable for ${dateStr}; used hardcoded default — verify before saving.`
        );
        const localFmt = new Date(gameTime).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/New_York',
        });
        results.push(`${PERIOD_LABELS[period]}: <strong>${dateStr}</strong> — ${localFmt} ET (default)`);
      } else {
        warnings.push(`${PERIOD_LABELS[period]}: no game data found and no default available.`);
      }
    }

    if (gameTime) periodDeadlines[period] = gameTime;
  }

  // Step 4: save everything to season data
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  sd.asg_date = asgDate;
  sd.schedule_dates = schedDates;
  if (!sd.period_deadlines) sd.period_deadlines = {};
  Object.assign(sd.period_deadlines, periodDeadlines);
  setSeasonsLocal(seasons);
  saveSchedule(SELECTED_SEASON, { schedule_dates: schedDates, asg_date: asgDate, period_deadlines: periodDeadlines });

  // Step 5: update UI inputs
  const asgInputEl = document.getElementById('asg-date-input');
  if (asgInputEl) asgInputEl.value = asgDate;

  for (const [period, isoStr] of Object.entries(periodDeadlines)) {
    const inputEl = document.getElementById(`period-deadline-input-${period}`);
    if (inputEl) inputEl.value = toLocalInputVal(isoStr);
    const pStatusEl = document.getElementById(`period-deadline-status-${period}`);
    if (pStatusEl) pStatusEl.innerHTML = '';
  }

  // Step 6: refresh dependent views
  const asgStatusEl = document.getElementById('asg-date-status');
  if (asgStatusEl) asgStatusEl.innerHTML = '<span style="color:#10b981;">Schedule dates saved!</span>';
  renderScheduleDatesPreview();
  renderWeeklyUploadSections();

  // Step 7: show summary
  const resHtml = results.length
    ? `<ul style="margin:0.4rem 0 0;padding-left:1.25rem;">${results.map((r) => `<li>${r}</li>`).join('')}</ul>`
    : '';
  const warnHtml = warnings.length
    ? `<div style="color:#f59e0b;margin-top:0.4rem;">Notes:<ul style="margin:0.2rem 0 0;padding-left:1.25rem;">${warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>`
    : '';
  statusEl.innerHTML = `<span style="color:#10b981;font-weight:600;">Auto-fill complete.</span> Review the values below and save any changes.${resHtml}${warnHtml}`;
  btn.disabled = false;
}

function setupAutoFillButton() {
  const btn = document.getElementById('autofill-schedule-btn');
  if (!btn) return;
  btn.onclick = () => autoFillSchedule();
}

function renderScheduleDatesPreview() {
  const preview = document.getElementById('schedule-dates-preview');
  if (!preview) return;
  const dates = getScheduleDates();
  if (!dates || dates.length === 0) {
    preview.innerHTML = '<p style="color:#888;">No schedule dates set yet.</p>';
    return;
  }
  let html =
    '<table class="compact-table" style="width:100%;"><thead><tr><th>#</th><th>Round</th><th>Dates</th></tr></thead><tbody>';
  SEASON_SCHEDULE.forEach((s, i) => {
    const d = dates[i];
    if (!d) return;
    if (i > 0 && SEASON_SCHEDULE[i - 1].round !== s.round) {
      const brk = interRoundBreak(dates[i - 1], d, SEASON_SCHEDULE[i - 1].round, s.round);
      if (brk) {
        html += `<tr class="schedule-break-row"><td>—</td><td>${brk.label}</td><td>${fmtDateRangeShort(brk.start, brk.end)}</td></tr>`;
      }
    }
    html += `<tr><td>${i + 1}</td><td>${s.label}</td><td>${fmtDateRangeShort(d.start, d.end)}</td></tr>`;
  });
  html += '</tbody></table>';
  preview.innerHTML = html;
}

// ---- Manager Management ----

function _mgrPwCell(m) {
  const hasCustomPw = !!m.hasCustomPassword;
  const pwInputId = 'pw-input-' + m.email.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const safeEmail = jsStr(m.email.toLowerCase());
  return `<div class="mgr-pw-cell">
    <span class="${hasCustomPw ? 'swap-badge swap-badge-approved' : 'swap-badge swap-badge-pending'}" style="font-size:0.7rem;">${hasCustomPw ? 'Custom' : 'Default'}</span>
    <input type="text" id="${pwInputId}" class="form-input mgr-pw-input" placeholder="New password">
    <button class="btn btn-sm btn-primary" onclick="setManagerPassword('${safeEmail}')" style="font-size:0.75rem;padding:0.2rem 0.45rem;">Set</button>
    ${hasCustomPw ? `<button class="btn btn-sm btn-secondary" onclick="resetManagerPassword('${safeEmail}')" style="font-size:0.75rem;padding:0.2rem 0.45rem;">Reset</button>` : ''}
  </div>`;
}

function _mgrNormalRow(m, idx) {
  const poolLabel = m.pool ? formatPool(m.pool) : '—';
  return `<tr id="mgr-row-${idx}">
    <td><strong>${esc(m.name)}</strong></td>
    <td style="font-size:0.85rem;">${m.email}</td>
    <td style="font-size:0.82rem;color:var(--text-muted);">${m.googleEmail ? esc(m.googleEmail) : '—'}</td>
    <td>${m.active !== false ? poolLabel : '<span style="color:var(--text-muted)">—</span>'}</td>
    <td style="white-space:nowrap;"><button class="btn btn-sm btn-secondary" onclick="inlineEditManager(${idx})">Edit</button></td>
    <td>${_mgrPwCell(m)}</td>
    <td>${m.commissioner ? '<span class="swap-badge swap-badge-approved" style="font-size:0.72rem;">Yes</span>' : '<span style="color:var(--text-muted);font-size:0.85rem;">No</span>'}</td>
    <td style="white-space:nowrap;"><button class="btn btn-sm btn-danger" onclick="deleteManager(${idx})">Delete</button></td>
  </tr>`;
}

function renderManagersTable() {
  const container = document.getElementById('managers-combined-view');
  if (!container) return;

  const managers = getManagers();
  const activeList = managers.map((m, i) => ({ ...m, _idx: i })).filter((m) => m.active !== false);
  const inactiveList = managers.map((m, i) => ({ ...m, _idx: i })).filter((m) => m.active === false);

  const tableHead = `<thead><tr>
    <th>Name</th><th>Email</th><th>Google Email</th><th>Pool</th><th></th><th>Password</th><th>Commissioner</th><th></th>
  </tr></thead>`;

  let html = `<p class="mgr-section-label">Active Managers <span class="mgr-count">(${activeList.length})</span></p>`;
  if (activeList.length > 0) {
    html += `<div class="mgr-table-wrap"><table class="data-table">${tableHead}<tbody>`;
    html += activeList.map((m) => _mgrNormalRow(m, m._idx)).join('');
    html += '</tbody></table></div>';
  } else {
    html += '<p class="text-muted" style="font-size:0.87rem;">No active managers.</p>';
  }

  // Add new manager form
  html += `<div class="add-mgr-area">
    <button class="btn btn-sm btn-primary" id="show-add-mgr-btn" onclick="showAddManagerForm()">+ Add Manager</button>
    <div class="add-mgr-form" id="add-mgr-form">
      <h4>Add New Manager</h4>
      <div class="add-mgr-fields">
        <input type="text" id="mgr-name" class="form-input" placeholder="Full Name" style="width:130px;">
        <input type="email" id="mgr-email" class="form-input" placeholder="Email" style="width:185px;">
        <input type="email" id="mgr-gemail" class="form-input" placeholder="Google email (defaults to email)" style="width:185px;">
        <select id="mgr-pool" class="form-select" style="width:90px;">
          <option value="">No Pool</option>
          <option value="1">Pool 1</option>
          <option value="2">Pool 2</option>
          <option value="3">Pool 3</option>
        </select>
        <label class="checkbox-label"><input type="checkbox" id="mgr-commissioner"> Comm</label>
        <label class="checkbox-label"><input type="checkbox" id="mgr-active" checked> Active</label>
        <button class="btn btn-sm btn-primary" id="save-manager-btn">Save</button>
        <button class="btn btn-sm btn-secondary" id="cancel-edit-btn" onclick="hideAddManagerForm()">Cancel</button>
      </div>
    </div>
  </div>`;

  if (inactiveList.length > 0) {
    html += `<div class="mgr-inactive-section">
      <p class="mgr-section-label">Inactive Managers <span class="mgr-count">(${inactiveList.length})</span></p>
      <div class="mgr-table-wrap"><table class="data-table">${tableHead}<tbody>`;
    html += inactiveList.map((m) => _mgrNormalRow(m, m._idx)).join('');
    html += '</tbody></table></div></div>';
  }

  container.innerHTML = html;

  document.getElementById('save-manager-btn').onclick = () => {
    const name = document.getElementById('mgr-name').value.trim();
    const email = document.getElementById('mgr-email').value.trim().toLowerCase();
    const googleEmail = document.getElementById('mgr-gemail').value.trim().toLowerCase() || email;
    const isCommissioner = document.getElementById('mgr-commissioner').checked;
    const isActive = document.getElementById('mgr-active').checked;
    const pool = isActive ? parseInt(document.getElementById('mgr-pool').value) || null : null;
    if (!name || !email) {
      alert('Name and email are required.');
      return;
    }
    const mgrs = getManagers();
    if (mgrs.find((m) => m.email.toLowerCase() === email)) {
      alert('A manager with this email already exists.');
      return;
    }
    mgrs.push({ name, email, googleEmail, commissioner: isCommissioner, active: isActive, pool });
    saveManagers(mgrs);
    renderManagersTable();
  };
}

window.showAddManagerForm = function () {
  document.getElementById('add-mgr-form').style.display = 'block';
  document.getElementById('show-add-mgr-btn').style.display = 'none';
};

window.hideAddManagerForm = function () {
  document.getElementById('add-mgr-form').style.display = 'none';
  document.getElementById('show-add-mgr-btn').style.display = 'inline-block';
  ['mgr-name', 'mgr-email', 'mgr-gemail'].forEach((id) => (document.getElementById(id).value = ''));
  document.getElementById('mgr-commissioner').checked = false;
  document.getElementById('mgr-active').checked = true;
  document.getElementById('mgr-pool').value = '';
};

window.inlineEditManager = function (idx) {
  const row = document.getElementById('mgr-row-' + idx);
  if (!row) return;
  const m = getManagers()[idx];
  if (!m) return;
  const safeEmail = jsStr(m.email.toLowerCase());
  const hasCustomPw = !!m.hasCustomPassword;
  const pwInputId = 'pw-input-' + m.email.toLowerCase().replace(/[^a-z0-9]/g, '-');
  row.innerHTML = `
    <td><input type="text" id="inline-mgr-name-${idx}" class="form-input" value="${esc(m.name)}" style="min-width:110px;"></td>
    <td><input type="email" id="inline-mgr-email-${idx}" class="form-input" value="${m.email}" style="min-width:130px;font-size:0.83rem;"></td>
    <td><input type="email" id="inline-mgr-gemail-${idx}" class="form-input" value="${esc(m.googleEmail || '')}" placeholder="Google email" style="min-width:130px;font-size:0.83rem;"></td>
    <td>
      <select id="inline-mgr-pool-${idx}" class="form-select" style="min-width:80px;">
        <option value="">None</option>
        <option value="1" ${Number(m.pool) === 1 ? 'selected' : ''}>Pool 1</option>
        <option value="2" ${Number(m.pool) === 2 ? 'selected' : ''}>Pool 2</option>
        <option value="3" ${Number(m.pool) === 3 ? 'selected' : ''}>Pool 3</option>
      </select>
    </td>
    <td style="white-space:nowrap;">
      <button class="btn btn-sm btn-success" onclick="saveInlineManager(${idx})">Save</button>
    </td>
    <td>
      <div class="mgr-pw-cell">
        <span class="${hasCustomPw ? 'swap-badge swap-badge-approved' : 'swap-badge swap-badge-pending'}" style="font-size:0.7rem;">${hasCustomPw ? 'Custom' : 'Default'}</span>
        <input type="text" id="${pwInputId}" class="form-input mgr-pw-input" placeholder="New password">
        <button class="btn btn-sm btn-primary" onclick="setManagerPassword('${safeEmail}')" style="font-size:0.75rem;padding:0.2rem 0.45rem;">Set</button>
        ${hasCustomPw ? `<button class="btn btn-sm btn-secondary" onclick="resetManagerPassword('${safeEmail}')" style="font-size:0.75rem;padding:0.2rem 0.45rem;">Reset</button>` : ''}
      </div>
    </td>
    <td>
      <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.82rem;white-space:nowrap;">
        <input type="checkbox" id="inline-mgr-comm-${idx}" ${m.commissioner ? 'checked' : ''}> Comm
      </label>
      <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.82rem;white-space:nowrap;margin-top:0.2rem;">
        <input type="checkbox" id="inline-mgr-active-${idx}" ${m.active !== false ? 'checked' : ''}> Active
      </label>
    </td>
    <td style="white-space:nowrap;">
      <button class="btn btn-sm btn-secondary" onclick="renderManagersTable()">Cancel</button>
    </td>`;
};

window.saveInlineManager = function (idx) {
  const name = document.getElementById('inline-mgr-name-' + idx)?.value.trim();
  const email = document
    .getElementById('inline-mgr-email-' + idx)
    ?.value.trim()
    .toLowerCase();
  const googleEmail =
    document
      .getElementById('inline-mgr-gemail-' + idx)
      ?.value.trim()
      .toLowerCase() || '';
  const isCommissioner = document.getElementById('inline-mgr-comm-' + idx)?.checked;
  const isActive = document.getElementById('inline-mgr-active-' + idx)?.checked;
  const pool = isActive ? parseInt(document.getElementById('inline-mgr-pool-' + idx)?.value) || null : null;
  if (!name || !email) {
    alert('Name and email are required.');
    return;
  }
  const mgrs = getManagers();
  if (mgrs.find((m, i) => i !== idx && m.email.toLowerCase() === email)) {
    alert('A manager with this email already exists.');
    return;
  }
  mgrs[idx] = { ...mgrs[idx], name, email, googleEmail, commissioner: isCommissioner, active: isActive, pool };
  saveManagers(mgrs);
  renderManagersTable();
};

window.deleteManager = function (index) {
  if (!confirm('Are you sure you want to delete this manager?')) return;
  const managers = getManagers();
  managers.splice(index, 1);
  saveManagers(managers);
  renderManagersTable();
};

// ---- Password Management ----
// Password UI is now merged into the combined manager view (renderManagersTable).
function renderPasswordManagement() {
  renderManagersTable();
}

window.setManagerPassword = async function (email) {
  const inputId = 'pw-input-' + email.replace(/[^a-z0-9]/g, '-');
  const input = document.getElementById(inputId);
  if (!input) return;
  const newPw = input.value.trim();
  if (!newPw) {
    alert('Please enter a password.');
    return;
  }
  if (newPw.length < 3) {
    alert('Password must be at least 3 characters.');
    return;
  }

  try {
    const resp = await apiFetch('/api/managers/' + encodeURIComponent(email) + '/password', {
      method: 'POST',
      body: JSON.stringify({ password: newPw }),
    });
    if (!resp.ok) {
      alert('Failed to update password. Please try again.');
      return;
    }
    input.value = '';
    await syncFromServer();
    renderPasswordManagement();
  } catch (e) {
    alert('Failed to update password. Please check your connection.');
  }
};

window.resetManagerPassword = async function (email) {
  if (!confirm("Reset this manager's password to the default?")) return;
  try {
    const resp = await apiFetch('/api/managers/' + encodeURIComponent(email) + '/password', {
      method: 'DELETE',
    });
    if (!resp.ok) {
      alert('Failed to reset password. Please try again.');
      return;
    }
    await syncFromServer();
    renderPasswordManagement();
  } catch (e) {
    alert('Failed to reset password. Please check your connection.');
  }
};

// Commissioner: open inline stat editor for a player
window.editPlayerStats = function (manager, statType, playerName, weekKey) {
  const [round, week] = weekKey.split('|');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const isBatting = statType === 'batting';
  const weeklyArr = isBatting ? sd.weekly_batting || [] : sd.weekly_pitching || [];
  const nameField = isBatting ? 'batter' : 'pitcher';
  // Also check null-manager records (stats that arrived after a player was dropped)
  let existing = weeklyArr.find(
    (r) => r[nameField] === playerName && r.manager === manager && r.round === round && r.week === week
  );
  if (!existing) {
    existing = weeklyArr.find((r) => r[nameField] === playerName && !r.manager && r.round === round && r.week === week);
  }

  // Build the edit dialog
  const dialogId = `stat-edit-dialog`;
  let dialog = document.getElementById(dialogId);
  if (dialog) dialog.remove();

  dialog = document.createElement('div');
  dialog.id = dialogId;
  dialog.className = 'stat-edit-overlay';

  const schedEntry = SEASON_SCHEDULE.find((s) => s.round === round && s.week === week);
  const weekLabel = schedEntry ? schedEntry.label : `${round} - ${week}`;

  let fieldsHtml = '';
  if (isBatting) {
    const fields = [
      { key: 'abs', label: 'AB' },
      { key: '1b', label: '1B' },
      { key: '2b', label: '2B' },
      { key: '3b', label: '3B' },
      { key: 'hr', label: 'HR' },
      { key: 'r', label: 'R' },
      { key: 'rbi', label: 'RBI' },
      { key: 'sb', label: 'SB' },
      { key: 'bb', label: 'BB' },
    ];
    fields.forEach((f) => {
      const val = existing ? existing[f.key] || 0 : 0;
      const isManual = existing && (existing.manual_fields || []).includes(f.key);
      fieldsHtml += `<div class="stat-edit-field">
        <label${isManual ? ' class="stat-edit-manual-label"' : ''}>${f.label}${isManual ? ' *' : ''}</label>
        <input type="number" id="se-${f.key}" value="${val}" step="any" min="0">
      </div>`;
    });
  } else {
    const fields = [
      { key: 'gs', label: 'GS' },
      { key: 'w', label: 'W' },
      { key: 'qs', label: 'QS' },
      { key: 'cg', label: 'CG' },
      { key: 'cgso', label: 'CGSO' },
      { key: 'nh', label: 'NH' },
      { key: 'ip', label: 'IP' },
      { key: 'h', label: 'H' },
      { key: 'er', label: 'ER' },
      { key: 'bb', label: 'BB' },
      { key: 'k', label: 'K' },
    ];
    fields.forEach((f) => {
      const val = existing ? existing[f.key] || 0 : 0;
      const isManual = existing && (existing.manual_fields || []).includes(f.key);
      fieldsHtml += `<div class="stat-edit-field">
        <label${isManual ? ' class="stat-edit-manual-label"' : ''}>${f.label}${isManual ? ' *' : ''}</label>
        <input type="number" id="se-${f.key}" value="${val}" step="any">
      </div>`;
    });
  }

  dialog.innerHTML = `<div class="stat-edit-card">
    <div class="stat-edit-header">
      <h3>Edit Stats: ${playerName}</h3>
      <span class="text-muted" style="font-size:0.8rem;">${manager} &middot; ${weekLabel}</span>
    </div>
    <div class="stat-edit-fields">${fieldsHtml}</div>
    <p class="text-muted" style="font-size:0.72rem;margin-top:0.5rem;">* = previously edited by commissioner. Changed fields will be protected from future stat uploads.</p>
    <div class="stat-edit-actions">
      <button class="btn btn-primary" onclick="savePlayerStats('${jsStr(manager)}','${statType}','${jsStr(playerName)}','${weekKey}')">Save</button>
      <button class="btn btn-secondary" onclick="document.getElementById('${dialogId}').remove()">Cancel</button>
    </div>
  </div>`;

  document.body.appendChild(dialog);
};

// Commissioner: save edited stats for a player
window.savePlayerStats = function (manager, statType, playerName, weekKey) {
  const [round, week] = weekKey.split('|');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const isBatting = statType === 'batting';
  const nameField = isBatting ? 'batter' : 'pitcher';

  if (isBatting) {
    if (!sd.weekly_batting) sd.weekly_batting = [];
    const idx = sd.weekly_batting.findIndex(
      (r) => r[nameField] === playerName && r.manager === manager && r.round === round && r.week === week
    );
    const existing = idx >= 0 ? sd.weekly_batting[idx] : null;
    const prevManualFields = existing ? existing.manual_fields || [] : [];

    const newStats = {
      abs: parseNum(document.getElementById('se-abs').value),
      '1b': parseNum(document.getElementById('se-1b').value),
      '2b': parseNum(document.getElementById('se-2b').value),
      '3b': parseNum(document.getElementById('se-3b').value),
      hr: parseNum(document.getElementById('se-hr').value),
      r: parseNum(document.getElementById('se-r').value),
      rbi: parseNum(document.getElementById('se-rbi').value),
      sb: parseNum(document.getElementById('se-sb').value),
      bb: parseNum(document.getElementById('se-bb').value),
    };

    // Determine which fields changed from existing values
    const changedFields = new Set(prevManualFields);
    const statKeys = ['abs', '1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb'];
    statKeys.forEach((k) => {
      const oldVal = existing ? existing[k] || 0 : 0;
      if (newStats[k] !== oldVal) changedFields.add(k);
    });

    const weeklyScore = calculateBattingScore(newStats);

    const record = {
      round,
      week,
      manager: manager,
      batter: playerName,
      status: 'Manual',
      ...newStats,
      weekly_score: weeklyScore,
      total_score: 0,
      manual_fields: [...changedFields],
    };

    if (idx >= 0) {
      sd.weekly_batting[idx] = record;
    } else {
      sd.weekly_batting.push(record);
    }
    // A replacement at the same length is invisible to the row index's length check.
    invalidateWeeklyRowIndex(sd.weekly_batting);

    // Recompute total_score for this batter
    let total = 0;
    sd.weekly_batting.forEach((b) => {
      if (b.batter === playerName) total += b.weekly_score || 0;
    });
    sd.weekly_batting
      .filter((b) => b.batter === playerName)
      .forEach((b) => {
        b.total_score = Math.round(total * 100) / 100;
      });
  } else {
    if (!sd.weekly_pitching) sd.weekly_pitching = [];
    const idx = sd.weekly_pitching.findIndex(
      (r) => r[nameField] === playerName && r.manager === manager && r.round === round && r.week === week
    );
    const existing = idx >= 0 ? sd.weekly_pitching[idx] : null;
    const prevManualFields = existing ? existing.manual_fields || [] : [];

    const newStats = {
      gs: parseNum(document.getElementById('se-gs').value),
      w: parseNum(document.getElementById('se-w').value),
      qs: parseNum(document.getElementById('se-qs').value),
      cg: parseNum(document.getElementById('se-cg').value),
      cgso: parseNum(document.getElementById('se-cgso').value),
      nh: parseNum(document.getElementById('se-nh').value),
      ip: parseNum(document.getElementById('se-ip').value),
      h: parseNum(document.getElementById('se-h').value),
      er: parseNum(document.getElementById('se-er').value),
      bb: parseNum(document.getElementById('se-bb').value),
      k: parseNum(document.getElementById('se-k').value),
    };

    // Determine which fields changed from existing values
    const changedFields = new Set(prevManualFields);
    const statKeys = ['gs', 'w', 'qs', 'cg', 'cgso', 'nh', 'ip', 'h', 'er', 'bb', 'k'];
    statKeys.forEach((k) => {
      const oldVal = existing ? existing[k] || 0 : 0;
      if (newStats[k] !== oldVal) changedFields.add(k);
    });

    const weeklyScore = calculatePitchingScore(newStats);

    const record = {
      round,
      week,
      manager: manager,
      pitcher: playerName,
      status: 'Manual',
      ...newStats,
      weekly_score: weeklyScore,
      manual_fields: [...changedFields],
    };

    if (idx >= 0) {
      sd.weekly_pitching[idx] = record;
    } else {
      sd.weekly_pitching.push(record);
    }
    // A replacement at the same length is invisible to the row index's length check.
    invalidateWeeklyRowIndex(sd.weekly_pitching);
  }

  // Auto-add to roster for this week if not already
  if (!sd.rosters) sd.rosters = {};
  if (!sd.rosters[manager]) sd.rosters[manager] = {};
  if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };
  const rosterKey = isBatting ? 'batters' : 'pitchers';
  if (!sd.rosters[manager][weekKey][rosterKey].includes(playerName)) {
    sd.rosters[manager][weekKey][rosterKey].push(playerName);
  }

  saveSeason(SELECTED_SEASON, sd);

  // Close dialog
  const dialog = document.getElementById('stat-edit-dialog');
  if (dialog) dialog.remove();

  // Re-render the roster view
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Add a player to a specific week's roster for a manager
// Type-to-search player add
window.addToRosterFromSearch = function (manager, type, inputId, weekKey) {
  const input = document.getElementById(inputId);
  const player = input.value.trim();
  if (!player || !weekKey) return;

  // Validate the player is in the pool
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const pool = type === 'batters' ? sd.batters_pool || [] : sd.pitchers_pool || [];
  const match = pool.find((p) => p.toLowerCase() === player.toLowerCase());
  if (!match) {
    alert('Player not found in pool. Please select from suggestions.');
    return;
  }

  // Use the actual pool name (correct casing)
  input.value = match;
  window.addToRoster(manager, type, inputId, weekKey);
};

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Setup player search event listeners (called after roster HTML is rendered)
function setupPlayerSearchInputs() {
  document.querySelectorAll('.player-search-input').forEach((input) => {
    if (input._searchBound) return;
    input._searchBound = true;
    let resultsDiv = document.getElementById('results-' + input.id);
    if (!resultsDiv) {
      resultsDiv = document.getElementById(input.id.replace('add-', 'results-'));
    }
    if (!resultsDiv) return;

    input.addEventListener('input', () => {
      const query = stripAccents(input.value.trim().toLowerCase());
      if (query.length < 1) {
        resultsDiv.innerHTML = '';
        resultsDiv.style.display = 'none';
        return;
      }

      const seasons = getSeasons();
      const sd = seasons[SELECTED_SEASON];
      const poolType = input.dataset.poolType;
      const pool = poolType === 'batters' ? sd.batters_pool || [] : sd.pitchers_pool || [];
      const weekKey = input.dataset.weekKey;
      const manager = input.dataset.manager;

      // Get already rostered/selected players to exclude from results
      let rostered = [];
      if (weekKey === 'initial') {
        const sub = sd.initial_submissions && sd.initial_submissions[manager];
        rostered = sub ? sub[poolType] || [] : [];
      } else if (weekKey && weekKey.startsWith('period-')) {
        const periodKey = weekKey.slice('period-'.length);
        const sub = getPeriodSub(sd, periodKey, manager);
        rostered = sub ? sub[poolType] || [] : [];
      } else {
        const roster = sd.rosters && sd.rosters[manager] && sd.rosters[manager][weekKey];
        rostered = roster ? roster[poolType] || [] : [];
      }

      const matches = pool
        .filter((p) => {
          if (rostered.includes(p)) return false;
          const norm = stripAccents(p.toLowerCase());
          const parts = norm.split(/\s+/);
          return parts.some((part) => part.startsWith(query)) || norm.includes(query);
        })
        .slice(0, 8);

      if (matches.length === 0) {
        resultsDiv.innerHTML = '';
        resultsDiv.style.display = 'none';
        return;
      }
      resultsDiv.style.display = 'block';
      resultsDiv.innerHTML = matches
        .map(
          (m) =>
            `<div class="player-search-item" onmousedown="selectPlayerSearchResult('${input.id}','${jsStr(m)}')" ontouchstart="event.preventDefault();selectPlayerSearchResult('${input.id}','${jsStr(m)}')">${displayPlayer(m, sd)}</div>`
        )
        .join('');
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (resultsDiv) {
          resultsDiv.innerHTML = '';
          resultsDiv.style.display = 'none';
        }
      }, 200);
    });
  });
}

window.selectPlayerSearchResult = function (inputId, playerName) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = playerName;
    // Handle both 'add-' prefixed and 'comm-add-' prefixed results divs
    let resultsDiv = document.getElementById(inputId.replace('add-', 'results-'));
    if (!resultsDiv) resultsDiv = document.getElementById('results-' + inputId);
    if (resultsDiv) {
      resultsDiv.innerHTML = '';
      resultsDiv.style.display = 'none';
    }
  }
};

function setupSwapPlayerSearch() {
  const searchInput = document.getElementById('swap-player-in-search');
  const hiddenInput = document.getElementById('swap-player-in');
  const resultsDiv = document.getElementById('swap-player-in-results');
  if (!searchInput || !hiddenInput || !resultsDiv) return;
  if (searchInput._searchBound) return;
  searchInput._searchBound = true;

  searchInput.addEventListener('input', () => {
    hiddenInput.value = '';
    const query = stripAccents(searchInput.value.trim().toLowerCase());
    if (!query) {
      resultsDiv.style.display = 'none';
      resultsDiv.innerHTML = '';
      return;
    }
    const dataEl = document.getElementById('swap-roster-data');
    if (!dataEl) return;
    const data = JSON.parse(dataEl.textContent);
    const isBatter = document.getElementById('swap-type-batter')?.classList.contains('active');
    const pool = isBatter ? data.availBatters || [] : data.availPitchers || [];
    const teamMap = Object.assign({}, data.battersTeam || {}, data.pitchersTeam || {});
    const matches = pool
      .filter((p) => {
        const norm = stripAccents(p.toLowerCase());
        const parts = norm.split(/\s+/);
        return parts.some((part) => part.startsWith(query)) || norm.includes(query);
      })
      .slice(0, 10);
    if (!matches.length) {
      resultsDiv.style.display = 'none';
      resultsDiv.innerHTML = '';
      return;
    }
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = matches
      .map((p) => {
        const t = teamMap[p];
        const label = t && !p.endsWith(`(${t})`) ? `${esc(p)} (${esc(t)})` : esc(p);
        return `<div class="player-search-item" onmousedown="selectSwapPlayerIn('${jsStr(p)}')" ontouchstart="event.preventDefault();selectSwapPlayerIn('${jsStr(p)}')">${label}</div>`;
      })
      .join('');
  });

  searchInput.addEventListener('blur', () => {
    setTimeout(() => {
      resultsDiv.innerHTML = '';
      resultsDiv.style.display = 'none';
    }, 200);
  });
}

window.selectSwapPlayerIn = function (playerName) {
  const searchInput = document.getElementById('swap-player-in-search');
  const hiddenInput = document.getElementById('swap-player-in');
  const resultsDiv = document.getElementById('swap-player-in-results');
  if (searchInput) searchInput.value = playerName;
  if (hiddenInput) hiddenInput.value = playerName;
  if (resultsDiv) {
    resultsDiv.innerHTML = '';
    resultsDiv.style.display = 'none';
  }
  window.refreshSwapAutoEffectiveDate();
};

// ---- Initial Player Submission Handlers ----
window.addInitialPlayer = async function (manager, type) {
  const inputId = type === 'batters' ? 'initial-add-bat' : 'initial-add-pit';
  const input = document.getElementById(inputId);
  if (!input) return;
  const player = input.value.trim();
  if (!player) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const pool = type === 'batters' ? sd.batters_pool || [] : sd.pitchers_pool || [];
  const match = pool.find((p) => p.toLowerCase() === player.toLowerCase());
  if (!match) {
    alert('Player not found in pool. Please select from suggestions.');
    return;
  }

  const sub = ensurePeriodSub(sd, 'pp1', manager);
  const maxCount = type === 'batters' ? 4 : 3;
  if ((sub[type] || []).length >= maxCount) {
    alert(`Maximum ${maxCount} ${type} allowed.`);
    return;
  }

  if (!sub[type]) sub[type] = [];
  if (sub[type].includes(match)) {
    alert('Player already in your submission.');
    return;
  }
  sub[type].push(match);

  if (!(await persistSubmission('pp1', manager, sub))) return;
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.removeInitialPlayer = async function (manager, type, player) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];
  if (sub.status === 'approved') return;

  sub[type] = (sub[type] || []).filter((p) => p !== player);
  if (!(await persistSubmission('pp1', manager, sub))) return;
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.submitInitialRoster = async function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];

  if ((sub.batters || []).length !== 4 || (sub.pitchers || []).length !== 3) {
    alert('You must select exactly 4 batters and 3 pitchers.');
    return;
  }

  sub.status = 'pending';
  if (!(await persistSubmission('pp1', manager, sub))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Players claimed by ANOTHER manager within `roundKey`'s period — the authoritative ownership for
// an approval conflict check. Sources: each OTHER manager's APPROVED submission for the period plus
// their period-scoped roster_dates (honoring drops via the latest add/drop per player). Deliberately
// NOT the raw roster arrays: those are a derived cache that can hold stale carry-forward / orphan
// entries (e.g. a PP1 holdover resurrected into a PP2 array), which would cause a false "already on
// another roster" block. Returns { player: managerName }.
function playersClaimedByOthers(sd, period, roundKey, excludeManager) {
  const claimed = {};
  const subBucket = period === 'pp1' ? sd.initial_submissions || {} : (sd.period_submissions || {})[period] || {};
  for (const [mgrName, s] of Object.entries(subBucket)) {
    if (mgrName === excludeManager || !s || s.status !== 'approved') continue;
    for (const p of [...(s.batters || []), ...(s.pitchers || [])]) claimed[p] = mgrName;
  }
  for (const [mgrName, weeks] of Object.entries(sd.roster_dates || {})) {
    if (mgrName === excludeManager) continue;
    const latestAdd = {};
    const latestDrop = {};
    for (const [wKey, players] of Object.entries(weeks || {})) {
      if (wKey.split('|')[0] !== roundKey) continue;
      for (const [p, d] of Object.entries(players || {})) {
        if (d.add_date && (!latestAdd[p] || d.add_date > latestAdd[p])) latestAdd[p] = d.add_date;
        if (d.drop_date && (!latestDrop[p] || d.drop_date > latestDrop[p])) latestDrop[p] = d.drop_date;
      }
    }
    for (const p of Object.keys(latestAdd)) {
      if (!latestDrop[p] || latestAdd[p] >= latestDrop[p]) claimed[p] = mgrName;
    }
  }
  return claimed;
}

window.approveInitialSubmission = async function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];

  // Players already claimed by another manager in the initial period (PP1). Read from approved
  // submissions + period roster_dates (authoritative), never the raw arrays, so a stale
  // carry-forward entry can't cause a false conflict.
  const initialRound = SEASON_SCHEDULE[0].round;
  const rosteredPlayers = playersClaimedByOthers(sd, 'pp1', initialRound, manager);
  const duplicates = [];
  (sub.batters || []).forEach((b) => {
    if (rosteredPlayers[b]) duplicates.push(`${b} (rostered by ${rosteredPlayers[b]})`);
  });
  (sub.pitchers || []).forEach((p) => {
    if (rosteredPlayers[p]) duplicates.push(`${p} (rostered by ${rosteredPlayers[p]})`);
  });
  if (duplicates.length > 0) {
    alert(`Cannot approve: the following players are already on another roster:\n\n${duplicates.join('\n')}`);
    return;
  }

  // A late roster with no effective date cannot be approved — see submissionAddDate.
  if (blockLateApprovalWithoutDate(sub, manager, 'Pool Play 1')) return;

  sub.status = 'approved';
  // Persist the approval atomically first; only touch the Week 1 roster if it stuck.
  const saved = await persistSubmission('pp1', manager, sub);
  if (!saved) return;

  // Add all players to Week 1 roster
  const firstWeek = SEASON_SCHEDULE[0];
  const weekKey = `${firstWeek.round}|${firstWeek.week}`;
  if (!sd.rosters) sd.rosters = {};
  if (!sd.rosters[manager]) sd.rosters[manager] = {};
  if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };

  // Each player's add_date: normally PP1's own first day, but a roster submitted after opening
  // day starts on the effective date the server stamped instead (submissionAddDate).
  const weekOneStart = sd.schedule_dates && sd.schedule_dates[0] ? sd.schedule_dates[0].start : null;
  const pp1StartDate = submissionAddDate(saved, weekOneStart);
  if (pp1StartDate) {
    if (!sd.roster_dates) sd.roster_dates = {};
    if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
    if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
  }

  // If PP1 hasn't started yet (approved during the early submission window), mark Week 1 as
  // legitimately advanced so repairCarryForwardRosters doesn't purge the approved roster as a
  // speculative future write.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (weekOneStart && weekOneStart > todayET) {
    if (!Array.isArray(sd.advanced_weeks)) sd.advanced_weeks = [];
    if (!sd.advanced_weeks.includes(0)) sd.advanced_weeks.push(0);
  }

  // Reconcile: remove any players currently in the Week 1 roster who are not in this
  // (re-)submission. This handles updated initial submissions where the manager swapped
  // out players before the commissioner approved — the old approval must not persist.
  const submittedBatters = new Set(sub.batters || []);
  const submittedPitchers = new Set(sub.pitchers || []);
  const prevBatters = (sd.rosters[manager][weekKey].batters || []).filter((b) => !submittedBatters.has(b));
  const prevPitchers = (sd.rosters[manager][weekKey].pitchers || []).filter((p) => !submittedPitchers.has(p));
  [...prevBatters, ...prevPitchers].forEach((player) => {
    // Erase the roster_dates entry so the player doesn't reappear via the historical path
    if (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) {
      delete sd.roster_dates[manager][weekKey][player];
    }
    // Remove any non-locked weekly stats for this player in Week 1
    if (sd.weekly_batting) {
      sd.weekly_batting = sd.weekly_batting.filter(
        (b) => !(b.batter === player && b.round === firstWeek.round && b.week === firstWeek.week && !b.drop_locked)
      );
    }
    if (sd.weekly_pitching) {
      sd.weekly_pitching = sd.weekly_pitching.filter(
        (p) => !(p.pitcher === player && p.round === firstWeek.round && p.week === firstWeek.week && !p.drop_locked)
      );
    }
    // Remove daily snapshot records for this player in Week 1 (no stats should count pre-roster)
    if (sd.daily_batting) {
      sd.daily_batting = sd.daily_batting.filter(
        (b) => !(b.batter === player && b.round === firstWeek.round && b.week === firstWeek.week)
      );
    }
    if (sd.daily_pitching) {
      sd.daily_pitching = sd.daily_pitching.filter(
        (p) => !(p.pitcher === player && p.round === firstWeek.round && p.week === firstWeek.week)
      );
    }
  });
  sd.rosters[manager][weekKey].batters = (sd.rosters[manager][weekKey].batters || []).filter((b) =>
    submittedBatters.has(b)
  );
  sd.rosters[manager][weekKey].pitchers = (sd.rosters[manager][weekKey].pitchers || []).filter((p) =>
    submittedPitchers.has(p)
  );

  (sub.batters || []).forEach((b) => {
    if (!sd.rosters[manager][weekKey].batters.includes(b)) {
      sd.rosters[manager][weekKey].batters.push(b);
    }
    if (pp1StartDate) {
      if (!sd.roster_dates[manager][weekKey][b]) sd.roster_dates[manager][weekKey][b] = {};
      sd.roster_dates[manager][weekKey][b].add_date = pp1StartDate;
    }
  });
  (sub.pitchers || []).forEach((p) => {
    if (!sd.rosters[manager][weekKey].pitchers.includes(p)) {
      sd.rosters[manager][weekKey].pitchers.push(p);
    }
    if (pp1StartDate) {
      if (!sd.roster_dates[manager][weekKey][p]) sd.roster_dates[manager][weekKey][p] = {};
      sd.roster_dates[manager][weekKey][p].add_date = pp1StartDate;
    }
  });

  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.editInitialSubmission = function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];
  const containerId = 'initial-edit-' + manager.replace(/\s+/g, '-');
  const editDiv = document.getElementById(containerId);
  if (!editDiv) return;

  if (editDiv.style.display !== 'none') {
    editDiv.style.display = 'none';
    return;
  }

  const safeMgr = jsStr(manager);
  let editHtml = '<div style="padding:0.5rem 0;">';

  editHtml += '<div style="font-size:0.82rem;font-weight:600;margin-bottom:0.25rem;">Batters:</div>';
  (sub.batters || []).forEach((b, i) => {
    const pool = (sd.batters_pool || []).sort();
    editHtml += `<div style="margin-bottom:0.25rem;">
      <select class="form-select" style="max-width:220px;display:inline-block;font-size:0.82rem;" id="edit-init-bat-${manager.replace(/\s+/g, '-')}-${i}">
        ${pool.map((p) => `<option value="${p}"${p === b ? ' selected' : ''}>${p}</option>`).join('')}
      </select></div>`;
  });

  editHtml += '<div style="font-size:0.82rem;font-weight:600;margin:0.5rem 0 0.25rem;">Pitchers:</div>';
  (sub.pitchers || []).forEach((p, i) => {
    const pool = (sd.pitchers_pool || []).sort();
    editHtml += `<div style="margin-bottom:0.25rem;">
      <select class="form-select" style="max-width:220px;display:inline-block;font-size:0.82rem;" id="edit-init-pit-${manager.replace(/\s+/g, '-')}-${i}">
        ${pool.map((pl) => `<option value="${pl}"${pl === p ? ' selected' : ''}>${pl}</option>`).join('')}
      </select></div>`;
  });

  editHtml += `<button class="btn btn-sm btn-primary" style="margin-top:0.5rem;" onclick="saveInitialSubmissionEdits('${safeMgr}')">Save Changes</button>`;
  editHtml += '</div>';

  editDiv.innerHTML = editHtml;
  editDiv.style.display = 'block';
};

window.saveInitialSubmissionEdits = async function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];
  const idPrefix = manager.replace(/\s+/g, '-');

  const newBatters = [];
  for (let i = 0; i < (sub.batters || []).length; i++) {
    const sel = document.getElementById(`edit-init-bat-${idPrefix}-${i}`);
    if (sel) newBatters.push(sel.value);
  }
  const newPitchers = [];
  for (let i = 0; i < (sub.pitchers || []).length; i++) {
    const sel = document.getElementById(`edit-init-pit-${idPrefix}-${i}`);
    if (sel) newPitchers.push(sel.value);
  }

  if (!(await persistSubmission('pp1', manager, { ...sub, batters: newBatters, pitchers: newPitchers }))) return;
  renderPendingSwapRequests();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.denyInitialSubmission = async function (manager) {
  if (!confirm(`Deny initial roster submission for ${manager}? This will reset their submission.`)) return;
  if (!(await persistSubmission('pp1', manager, { batters: [], pitchers: [], status: 'draft' }))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Permanently remove a manager's Pool Play 1 (initial) submission record. Unlike Deny — which
// leaves an empty 'draft' record behind — this deletes the entry entirely, so it no longer shows
// in the pending list and is no longer treated as the authoritative Week 1 roster by the
// ghost-purge repair. The manager's actual Week 1 roster (sd.rosters) and stats are untouched.
window.deleteInitialSubmission = async function (manager) {
  if (
    !confirm(
      `Delete ${manager}'s Pool Play 1 submission record entirely?\n\n` +
        'This removes only the submission artifact — their existing Week 1 roster and scores are not affected. This cannot be undone.'
    )
  ) {
    return;
  }
  if (!(await removeSubmissionRemote('pp1', manager))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// ---- Period Submission Handlers (pp2 / qf / sf / finals) ----

window.addPeriodPlayer = async function (period, manager, type) {
  const inputId = `period-add-${type === 'batters' ? 'bat' : 'pit'}-${period}`;
  const input = document.getElementById(inputId);
  if (!input) return;
  const player = input.value.trim();
  if (!player) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const pool = type === 'batters' ? sd.batters_pool || [] : sd.pitchers_pool || [];
  const match = pool.find((p) => p.toLowerCase() === player.toLowerCase());
  if (!match) {
    alert('Player not found in pool. Please select from the suggestions.');
    return;
  }

  const sub = ensurePeriodSub(sd, period, manager);
  const maxCount = type === 'batters' ? 4 : 3;
  if ((sub[type] || []).length >= maxCount) {
    alert(`Maximum ${maxCount} ${type} allowed.`);
    return;
  }
  if (!sub[type]) sub[type] = [];
  if (sub[type].includes(match)) {
    alert('Player already in your submission.');
    return;
  }
  sub[type].push(match);
  if (!(await persistSubmission(period, manager, sub))) return;
  input.value = '';
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.removePeriodPlayer = async function (period, manager, type, player) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;
  sub[type] = (sub[type] || []).filter((p) => p !== player);
  if (!(await persistSubmission(period, manager, sub))) return;
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.submitPeriodRoster = async function (period, manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;
  if ((sub.batters || []).length !== 4 || (sub.pitchers || []).length !== 3) {
    alert('You must select exactly 4 batters and 3 pitchers.');
    return;
  }
  sub.status = 'pending';
  if (!(await persistSubmission(period, manager, sub))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// ---- Late-submission actions ----

// Submit a roster after its period's lock, taking the automatic next-viable effective date. The
// date is re-read from the server first: the manager may have had this page open since before
// first pitch, and the button label he is about to press must be the date he actually gets.
window.submitLateRoster = async function (period, manager) {
  const label = periodLabelForManager(period, manager);
  const win = await loadSubmissionWindow(period, { force: true });
  if (!win || !win.is_late) {
    // The window re-opened under us (a commissioner moved the schedule, or the clock was wrong).
    // Fall through to the ordinary path rather than filing a late roster that isn't one.
    return window.submitPeriodRoster(period, manager);
  }
  if (!win.effective_date) {
    alert(
      `${label} is over — there is no day left for a new roster to start on.\n\n` +
        'Use "Beg Commish for Forgiveness" instead; only the commissioner can back-date it now.'
    );
    const isComm = isLoggedInCommissioner();
    renderRosterData(manager, isComm);
    return;
  }
  if (
    !confirm(
      `You missed the ${label} deadline, so this roster counts from ${fmtEffectiveDate(win.effective_date)} ` +
        `— not from the start of the period.\n\nSubmit it for approval?`
    )
  ) {
    return;
  }
  await window.submitPeriodRoster(period, manager);
};

// Show/hide the plea box under a late period's Beg button.
window.toggleForgivenessForm = function (period) {
  const box = document.getElementById(`late-plea-${period}`);
  if (!box) return;
  const showing = box.style.display !== 'none';
  box.style.display = showing ? 'none' : 'block';
  if (!showing) {
    const ta = document.getElementById(`late-plea-${period}-text`);
    if (ta) ta.focus();
  }
};

// File the roster as a plea instead of a submission: it goes to the commissioner with NO
// effective date, and he chooses which day it counts from.
window.sendForgivenessRequest = async function (period, manager) {
  const label = periodLabelForManager(period, manager);
  const ta = document.getElementById(`late-plea-${period}-text`);
  const reason = ((ta && ta.value) || '').trim();
  if (!reason) {
    alert('Tell the commissioner why. A blank plea is just a late submission.');
    if (ta) ta.focus();
    return;
  }
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;
  if ((sub.batters || []).length !== 4 || (sub.pitchers || []).length !== 3) {
    alert('You must select exactly 4 batters and 3 pitchers before begging for forgiveness.');
    return;
  }
  if (!confirm(`Send your ${label} roster to the commissioner and ask him to back-date it?`)) return;

  sub.status = 'pending';
  if (!(await persistSubmission(period, manager, sub, { forgivenessReason: reason }))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// The commissioner's ruling. Granting takes the date out of the picker — the server validates it
// against the period's own bounds, because this is the one path that can start a roster earlier
// than the automatic rule allows. Denying needs no date: the roster drops to the automatic one.
window.decideForgiveness = async function (period, manager, decision, inputId) {
  const label = periodLabelForManager(period, manager);
  const input = document.getElementById(inputId);
  const effectiveDate = input ? input.value : '';
  if (decision === 'grant') {
    if (!effectiveDate) {
      alert('Pick the date this roster should start counting from.');
      return;
    }
    if (
      !confirm(
        `Back-date ${manager}'s ${label} roster to ${fmtEffectiveDate(effectiveDate)}?\n\n` +
          'Every player on it will be added as of that date and will score from then on.'
      )
    ) {
      return;
    }
  } else if (!confirm(`Deny ${manager}'s request? His roster still counts, from the automatic date.`)) {
    return;
  }

  try {
    const resp = await apiFetch(
      `/api/seasons/${SELECTED_SEASON}/submissions/${period}/${encodeURIComponent(manager)}/forgiveness`,
      { method: 'POST', body: JSON.stringify({ decision, effective_date: effectiveDate || undefined }) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }
    const { submission, window: subWindow, _rev } = await resp.json();
    mirrorSubmissionLocally(period, manager, submission);
    cacheSubmissionWindow(period, subWindow);
    adoptRev(_rev);
  } catch (e) {
    alert(`Could not record that decision — ${e.message}. Please try again.`);
    return;
  }
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// The add_date every player on an approved submission gets. Normally the period's first day; for
// a LATE roster, the effective date the server stamped (or the commissioner back-dated to).
//
// Returns null when a late roster has no effective date at all — a plea nobody has ruled on, or a
// period that ran out. Approving that would silently back-date the roster to the period start,
// which is the exact thing the whole feature exists to prevent, so callers refuse instead.
function submissionAddDate(sub, periodStartDate) {
  const state = submissionLateState(sub);
  if (!state.late) return periodStartDate;
  return state.effectiveDate || null;
}

// Shared guard for both approval paths. Returns true when approval must not proceed.
function blockLateApprovalWithoutDate(sub, manager, periodLabel) {
  const state = submissionLateState(sub);
  if (!state.late || state.effectiveDate) return false;
  alert(
    `${manager}'s ${periodLabel} roster was submitted late and has no effective date yet.\n\n` +
      (state.forgivenessPending
        ? 'Rule on the forgiveness request first — granting it is how the date gets set.'
        : 'The period has no viable day left. Grant forgiveness with a date to approve this roster.')
  );
  return true;
}

window.approvePeriodSubmission = async function (period, manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;

  const periodToRound = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };
  const roundKey = periodToRound[period];

  // Duplicate-roster check against other managers — scoped to THIS period, read from approved
  // submissions + period roster_dates (authoritative), never the raw roster arrays. Each scoring
  // period is drafted fresh, so a PRIOR-period holdover must not block; and a stale carry-forward
  // entry sitting in another manager's array (no submission/roster_dates behind it) must not cause
  // a false conflict either. Only a genuine same-period claim blocks.
  const rosteredByOther = playersClaimedByOthers(sd, period, roundKey, manager);
  const dups = [];
  (sub.batters || []).forEach((b) => {
    if (rosteredByOther[b]) dups.push(`${b} (${rosteredByOther[b]})`);
  });
  (sub.pitchers || []).forEach((p) => {
    if (rosteredByOther[p]) dups.push(`${p} (${rosteredByOther[p]})`);
  });
  if (dups.length > 0) {
    alert(`Cannot approve: these players are already on another roster:\n\n${dups.join('\n')}`);
    return;
  }

  // A late roster with no effective date cannot be approved — see submissionAddDate.
  if (blockLateApprovalWithoutDate(sub, manager, periodLabelForManager(period, manager))) return;

  sub.status = 'approved';
  // Persist the approval atomically first; only touch the Week 1 roster if it stuck.
  const saved = await persistSubmission(period, manager, sub);
  if (!saved) return;

  // Set the first week of the corresponding round to EXACTLY the submission.
  const firstEntry = roundKey ? SEASON_SCHEDULE.find((s) => s.round === roundKey && s.week === 'Week 1') : null;
  if (firstEntry) {
    const weekKey = `${firstEntry.round}|${firstEntry.week}`;
    const weekIdx = SEASON_SCHEDULE.indexOf(firstEntry);
    const weekStart = sd.schedule_dates && sd.schedule_dates[weekIdx] ? sd.schedule_dates[weekIdx].start : null;
    // If this period hasn't started yet (its Week 1 is in the future), mark the week as
    // legitimately advanced so repairCarryForwardRosters doesn't purge the approved starting
    // roster as a speculative future write. (Windows open before a round begins, so approving
    // a PP2/playoff — or an early PP1 — submission writes a future-week roster.)
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (weekStart && weekStart > todayET) {
      if (!Array.isArray(sd.advanced_weeks)) sd.advanced_weeks = [];
      if (!sd.advanced_weeks.includes(weekIdx)) sd.advanced_weeks.push(weekIdx);
    }
    if (!sd.rosters) sd.rosters = {};
    if (!sd.rosters[manager]) sd.rosters[manager] = {};
    // REPLACE, don't append: the period's Week 1 roster IS the submission. Overwriting drops any
    // stale carry-forward / orphan player sitting in the array from a prior period (the bug where
    // a resurrected holdover left an approved manager with a 5th batter). In-period swaps happen
    // after approval and are re-applied by repairCarryForwardRosters from the swap records.
    sd.rosters[manager][weekKey] = { batters: [...(sub.batters || [])], pitchers: [...(sub.pitchers || [])] };
    // The add_date is the scoring invariant's own unit, so a LATE roster needs no special case
    // anywhere downstream — it simply carries a later add_date and scores a shorter window. The
    // week key stays the period's first week either way: managerWeekSubtotal and
    // rebuildRosterArraysFromDates both pool a manager's dates across the period's weeks and
    // filter by each week's end, so an add_date landing in Week 2 scores in Week 2 and nowhere
    // earlier.
    const addDate = submissionAddDate(saved, weekStart);
    if (addDate) {
      if (!sd.roster_dates) sd.roster_dates = {};
      if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
      const dates = {};
      for (const p of [...(sub.batters || []), ...(sub.pitchers || [])]) dates[p] = { add_date: addDate };
      sd.roster_dates[manager][weekKey] = dates;
    }
  }

  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.denyPeriodSubmission = async function (period, manager) {
  const label = periodLabelForManager(period, manager);
  if (!confirm(`Deny ${label} submission for ${manager}? Their selection will be reset to draft.`)) return;
  const draft = { batters: [], pitchers: [], status: 'draft' };
  if (!(await persistSubmission(period, manager, draft))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Permanently remove a manager's submission record for a period (pp2/qf/sf/finals). Unlike Deny —
// which leaves an empty 'draft' record behind — this deletes the entry entirely. The manager's
// actual roster (sd.rosters) is untouched; only the submission artifact is removed.
window.deletePeriodSubmission = async function (period, manager) {
  const label = periodLabelForManager(period, manager);
  if (
    !confirm(
      `Delete ${manager}'s ${label} submission record entirely?\n\n` +
        'This removes only the submission artifact — their existing roster and scores are not affected. This cannot be undone.'
    )
  ) {
    return;
  }
  if (!(await removeSubmissionRemote(period, manager))) return;
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Called when a manager clicks "Edit Submission" on their approved roster (before the deadline)
window.editApprovedPeriodSubmission = async function (period, manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;

  if (!isPeriodTimeOpen(sd, period)) {
    alert('The submission edit window has closed.');
    return;
  }

  const label = submissionPeriodLabel(sd, period, manager);
  if (
    !confirm(
      `Editing your ${label} submission will un-approve your current roster and require commissioner re-approval.\n\n` +
        'Your current player selections will be preserved so you only need to change the players you want to swap.\n\n' +
        'Continue?'
    )
  ) {
    return;
  }

  // Un-approve the submission atomically first; only clear the roster if it stuck.
  sub.status = 'draft';
  if (!(await persistSubmission(period, manager, sub))) return;

  // Remove the approved players from the period's Week 1 roster
  const periodToRound = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };
  const roundKey = periodToRound[period];
  const firstEntry = roundKey ? SEASON_SCHEDULE.find((s) => s.round === roundKey && s.week === 'Week 1') : null;
  if (firstEntry && sd.rosters && sd.rosters[manager]) {
    const weekKey = `${firstEntry.round}|${firstEntry.week}`;
    if (sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };
  }

  saveSeason(SELECTED_SEASON, sd);
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Edit initial submission from the Commissioner Pending Swap Requests tab
window.editInitialSubmissionComm = function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];
  const idSafe = manager.replace(/\s+/g, '-');
  const editDiv = document.getElementById('comm-initial-edit-' + idSafe);
  if (!editDiv) return;

  if (editDiv.style.display !== 'none') {
    editDiv.style.display = 'none';
    return;
  }

  const safeMgr = jsStr(manager);
  let editHtml = '<div style="padding:0.5rem 0;">';

  editHtml += '<div style="font-size:0.82rem;font-weight:600;margin-bottom:0.25rem;">Batters:</div>';
  (sub.batters || []).forEach((b, i) => {
    const pool = (sd.batters_pool || []).sort();
    editHtml += `<div style="margin-bottom:0.25rem;">
      <select class="form-select" style="max-width:280px;display:inline-block;font-size:0.82rem;" id="comm-edit-init-bat-${idSafe}-${i}">
        ${pool.map((p) => `<option value="${p}"${p === b ? ' selected' : ''}>${displayPlayer(p, sd)}</option>`).join('')}
      </select></div>`;
  });

  editHtml += '<div style="font-size:0.82rem;font-weight:600;margin:0.5rem 0 0.25rem;">Pitchers:</div>';
  (sub.pitchers || []).forEach((p, i) => {
    const pool = (sd.pitchers_pool || []).sort();
    editHtml += `<div style="margin-bottom:0.25rem;">
      <select class="form-select" style="max-width:280px;display:inline-block;font-size:0.82rem;" id="comm-edit-init-pit-${idSafe}-${i}">
        ${pool.map((pl) => `<option value="${pl}"${pl === p ? ' selected' : ''}>${displayPlayer(pl, sd)}</option>`).join('')}
      </select></div>`;
  });

  editHtml += `<button class="btn btn-sm btn-primary" style="margin-top:0.5rem;" onclick="saveInitialSubmissionEditsComm('${safeMgr}')">Save Changes</button>`;
  editHtml += '</div>';

  editDiv.innerHTML = editHtml;
  editDiv.style.display = 'block';
};

window.saveInitialSubmissionEditsComm = async function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];
  const idSafe = manager.replace(/\s+/g, '-');

  const newBatters = [];
  for (let i = 0; i < (sub.batters || []).length; i++) {
    const sel = document.getElementById(`comm-edit-init-bat-${idSafe}-${i}`);
    if (sel) newBatters.push(sel.value);
  }
  const newPitchers = [];
  for (let i = 0; i < (sub.pitchers || []).length; i++) {
    const sel = document.getElementById(`comm-edit-init-pit-${idSafe}-${i}`);
    if (sel) newPitchers.push(sel.value);
  }

  if (!(await persistSubmission('pp1', manager, { ...sub, batters: newBatters, pitchers: newPitchers }))) return;
  renderPendingSwapRequests();
};

// Commissioner roster management in the Swaps tab
window.updateCommRosterWeekView = function (managerName) {
  const weekSelect = document.getElementById('comm-roster-week');
  if (!weekSelect) return;
  const weekKey = weekSelect.value;

  // Update search input data attributes
  const batInput = document.getElementById('comm-add-bat');
  const pitInput = document.getElementById('comm-add-pit');
  if (batInput) batInput.dataset.weekKey = weekKey;
  if (pitInput) pitInput.dataset.weekKey = weekKey;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;
  if (!sd.rosters) sd.rosters = {};
  // Automatic render-time save — silent so a stale-rev 409 never alerts/reloads (re-runs next render).
  if (backfillRosterDatesFromSwaps(sd)) saveSeason(SELECTED_SEASON, sd, { silent: true });
  const safeMgr = jsStr(managerName);

  const [round, week] = weekKey.split('|');
  let roster =
    sd.rosters[managerName] && sd.rosters[managerName][weekKey]
      ? sd.rosters[managerName][weekKey]
      : { batters: [], pitchers: [] };

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const weekBatting = batting.filter((b) => b.manager === managerName && b.round === round && b.week === week);
  const weekPitching = pitching.filter((p) => p.manager === managerName && p.round === round && p.week === week);

  // CUM PTS: player's total in this round while attributed to this manager.
  // CUM RANK: league-wide rank within this round.
  const commMgrRosters = (sd.rosters || {})[managerName] || {};
  const commMgrRosterDates = (sd.roster_dates || {})[managerName] || {};

  // Precompute weekKey → start date for dropped-player filtering in cumulative calculation.
  const commScheduleDates = getScheduleDates();
  const commWeekKeyToStart = {};
  SEASON_SCHEDULE.forEach((s, i) => {
    if (commScheduleDates && commScheduleDates[i]) {
      commWeekKeyToStart[`${s.round}|${s.week}`] = commScheduleDates[i].start;
    }
  });

  function commWasRostered(player, wkKey, type) {
    if (playerDroppedBeforeWeek(sd, commWeekKeyToStart, managerName, player, wkKey)) return false;
    const wkRoster = commMgrRosters[wkKey] || { batters: [], pitchers: [] };
    if ((type === 'bat' ? wkRoster.batters : wkRoster.pitchers).includes(player)) return true;
    return !!(commMgrRosterDates[wkKey] || {})[player];
  }
  const maxWeekNum = parseInt((week || '').split(' ')[1]) || Infinity;
  const commBatCum = {},
    commPitCum = {};
  (sd.weekly_batting || []).forEach((b) => {
    if (b.round !== round || !b.batter) return;
    if ((parseInt((b.week || '').split(' ')[1]) || 0) > maxWeekNum) return;
    if ((b.manager === managerName || b.manager === null) && commWasRostered(b.batter, `${b.round}|${b.week}`, 'bat')) {
      commBatCum[b.batter] = (commBatCum[b.batter] || 0) + (b.weekly_score || 0);
    }
  });
  (sd.weekly_pitching || []).forEach((p) => {
    if (p.round !== round || !p.pitcher) return;
    if ((parseInt((p.week || '').split(' ')[1]) || 0) > maxWeekNum) return;
    if (
      (p.manager === managerName || p.manager === null) &&
      commWasRostered(p.pitcher, `${p.round}|${p.week}`, 'pit')
    ) {
      commPitCum[p.pitcher] = (commPitCum[p.pitcher] || 0) + (p.weekly_score || 0);
    }
  });
  for (const k of Object.keys(commBatCum)) commBatCum[k] = Math.round(commBatCum[k] * 100) / 100;
  for (const k of Object.keys(commPitCum)) commPitCum[k] = Math.round(commPitCum[k] * 100) / 100;
  const periodScoresComm = computePeriodCumulativeScores(sd, round, week);
  const cumRankings = computeCumulativeRankings(periodScoresComm.batCumulative, periodScoresComm.pitCumulative);
  const weekRanks = computeWeeklyRankings(sd, round, week);

  // Swap log for date tags
  const approvedSwaps = (sd.swaps || []).filter((s) => s.manager === managerName && s.status === 'approved');
  const scheduleDates = getScheduleDates();
  const weekIdx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
  const seasonStartDate = scheduleDates && scheduleDates[0] ? scheduleDates[0].start : null;

  // Roster dates lookup
  const rosterDates =
    sd.roster_dates && sd.roster_dates[managerName] && sd.roster_dates[managerName][weekKey]
      ? sd.roster_dates[managerName][weekKey]
      : {};

  // Filter out players dropped (in a previous week's roster_dates) before this week's start.
  const weekStart = scheduleDates && scheduleDates[weekIdx] ? scheduleDates[weekIdx].start : null;
  if (weekStart && sd.roster_dates && sd.roster_dates[managerName]) {
    const allMgrDates = sd.roster_dates[managerName];
    const addedThisWeek = new Set([
      ...approvedSwaps.filter((s) => s.player_in && s.week_key === weekKey).map((s) => s.player_in),
      ...Object.entries(rosterDates)
        .filter(([, d]) => d.add_date)
        .map(([p]) => p),
    ]);
    const wasDroppedBefore = (player) => {
      if (addedThisWeek.has(player)) return false;
      for (const [wk, players] of Object.entries(allMgrDates)) {
        if (wk === weekKey) continue;
        const pd = players[player];
        if (pd && pd.drop_date && pd.drop_date < weekStart) {
          const reAddedLater = Object.values(allMgrDates).some(
            (wkp) => wkp[player] && wkp[player].add_date > pd.drop_date && wkp[player].add_date < weekStart
          );
          if (!reAddedLater) return true;
        }
      }
      return false;
    };
    roster = {
      batters: roster.batters.filter((p) => !wasDroppedBefore(p)),
      pitchers: roster.pitchers.filter((p) => !wasDroppedBefore(p)),
    };
  }

  // A SCHEDULED (future-dated) swap is recorded — and applied to the derived roster arrays — the
  // moment it is submitted. Re-derive both ends from the date windows AS OF TODAY so it doesn't
  // take effect early here either (same rule as buildPerWeekRoster):
  //   commPendingDrop — outgoing player, still rostered and still scoring until their drop date.
  //   commPendingAdd  — incoming player, listed but not on the roster until their add date.
  const commToday = isoDateET(new Date());
  const commPeriodStart = periodStartForSeason(sd, round);
  const commStatusAsOfToday = (player) => {
    const entries = [];
    for (const wkDates of Object.values(commMgrRosterDates)) {
      if (wkDates[player]) entries.push(wkDates[player]);
    }
    return rosterStatusAsOf(entries, { periodStart: commPeriodStart, asOf: commToday });
  };
  const commPendingDrop = new Set();
  const commPendingAdd = new Set();
  for (const [p, d] of Object.entries(rosterDates)) {
    if (d.drop_date && d.drop_date > commToday && commStatusAsOfToday(p) === 'active') commPendingDrop.add(p);
    if (d.add_date && d.add_date > commToday && commStatusAsOfToday(p) === 'scheduled') commPendingAdd.add(p);
  }
  // Which list a player belongs in — needed both to restore a pending drop into the right table
  // and to place a statless player who was only rostered for part of the week.
  const commBatPool = new Set(sd.batters_pool || []);
  const commPitPool = new Set(sd.pitchers_pool || []);
  const commPoolTypeOf = (player) => {
    const inBat = commBatPool.has(player);
    const inPit = commPitPool.has(player);
    if (inBat && !inPit) return 'batters';
    if (inPit && !inBat) return 'pitchers';
    for (const wr of Object.values(commMgrRosters)) {
      if ((wr.batters || []).includes(player)) return 'batters';
      if ((wr.pitchers || []).includes(player)) return 'pitchers';
    }
    if (batting.some((b) => b.batter === player)) return 'batters';
    if (pitching.some((p) => p.pitcher === player)) return 'pitchers';
    return null;
  };
  if (commPendingDrop.size > 0) {
    // The arrays are a derived cache — put the still-rostered player back where roster_dates says.
    const restore = (listKey) =>
      [...commPendingDrop].filter((p) => commPoolTypeOf(p) === listKey && !roster[listKey].includes(p));
    roster = {
      batters: roster.batters.concat(restore('batters')),
      pitchers: roster.pitchers.concat(restore('pitchers')),
    };
  }

  // Build the complete set of batters/pitchers who were on the roster at ANY point this week.
  // Sources: current roster (pool-filtered) + roster_dates (commissioner add/drop) + approved swaps.
  // Swap-added players are only included if they have actual stats or a roster_dates entry —
  // this prevents players who were dropped before any games were played from appearing.
  const historicalBatters = new Set([
    ...roster.batters,
    ...Object.keys(rosterDates).filter(
      (p) => !seasonStartDate || !rosterDates[p].drop_date || rosterDates[p].drop_date >= seasonStartDate
    ),
    ...approvedSwaps
      .filter(
        (s) =>
          s.player_in &&
          s.week_key === weekKey &&
          (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
          (rosterDates[s.player_in] ||
            batting.some((b) => b.batter === s.player_in && b.round === round && b.week === week))
      )
      .map((s) => s.player_in),
  ]);
  const historicalPitchers = new Set([
    ...roster.pitchers,
    ...Object.keys(rosterDates).filter(
      (p) => !seasonStartDate || !rosterDates[p].drop_date || rosterDates[p].drop_date >= seasonStartDate
    ),
    ...approvedSwaps
      .filter(
        (s) =>
          s.player_in &&
          s.week_key === weekKey &&
          (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
          (rosterDates[s.player_in] ||
            pitching.some((p) => p.pitcher === s.player_in && p.round === round && p.week === week))
      )
      .map((s) => s.player_in),
  ]);

  // Extend weekBatting/weekPitching with UNATTRIBUTED stats for historical roster members.
  // Stats synced after a player was dropped arrive with manager = null; without this they
  // would be invisible even though they should count for this manager.
  const allWeekBatting = weekBatting.slice();
  batting.forEach((b) => {
    if (
      b.round === round &&
      b.week === week &&
      !b.manager &&
      historicalBatters.has(b.batter) &&
      !allWeekBatting.some((x) => x.batter === b.batter)
    ) {
      allWeekBatting.push(b);
    }
  });
  const allWeekPitching = weekPitching.slice();
  pitching.forEach((p) => {
    if (
      p.round === round &&
      p.week === week &&
      !p.manager &&
      historicalPitchers.has(p.pitcher) &&
      !allWeekPitching.some((x) => x.pitcher === p.pitcher)
    ) {
      allWeekPitching.push(p);
    }
  });
  // Players dropped during this week (drop_date in current rosterDates) are treated as historical —
  // unless the drop is still scheduled, in which case they are simply on the roster.
  const commDroppedThisWeek = new Set(
    Object.entries(rosterDates)
      .filter(([p, d]) => d.drop_date && !commPendingDrop.has(p))
      .map(([p]) => p)
  );

  // Hide dropped players whose effective contribution to this week is zero —
  // stats coming from games outside the rostered window only add visual noise.
  const commPlayerWeekScore = (rows, key, name) => {
    const row = rows.find((r) => r[key] === name);
    return row ? row.weekly_score || 0 : 0;
  };
  // …unless they were actually on the roster for part of this week, in which case they belong in
  // the week's table with or without points — same rule as buildPerWeekRoster (a mid-week swap
  // leaves the outgoing player rostered for the days before it, and a blank stat line, or no
  // weekly row at all, must not erase them from the week they were swapped out of).
  const commWeekEnd = scheduleDates && scheduleDates[weekIdx] ? scheduleDates[weekIdx].end : null;
  const commRosteredDuringWeek = (player) => {
    const rd = rosterDates[player];
    const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
    const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
    if (!rd && !addSwap && !dropSwap) return false;
    const addDate = (rd && rd.add_date) || (addSwap && addSwap.swap_date) || null;
    const dropDate = (rd && rd.drop_date) || (dropSwap && dropSwap.swap_date) || null;
    if (seasonStartDate && dropDate && dropDate < seasonStartDate) return false;
    if (addDate && commWeekEnd && addDate > commWeekEnd) return false;
    if (dropDate && weekStart && dropDate < weekStart) return false;
    return true;
  };
  const droppedBatters = [...historicalBatters].filter((p) => {
    if (roster.batters.includes(p) && !commDroppedThisWeek.has(p)) return false;
    const scored = allWeekBatting.some((b) => b.batter === p) && commPlayerWeekScore(allWeekBatting, 'batter', p) > 0;
    return scored || (commPoolTypeOf(p) === 'batters' && commRosteredDuringWeek(p));
  });
  const droppedPitchers = [...historicalPitchers].filter((p) => {
    if (roster.pitchers.includes(p) && !commDroppedThisWeek.has(p)) return false;
    const scored =
      allWeekPitching.some((pt) => pt.pitcher === p) && commPlayerWeekScore(allWeekPitching, 'pitcher', p) > 0;
    return scored || (commPoolTypeOf(p) === 'pitchers' && commRosteredDuringWeek(p));
  });

  function getPlayerDates(player) {
    const rd = rosterDates[player];
    if (rd) return { add_date: rd.add_date || '', drop_date: rd.drop_date || '' };
    // Fall back to swap records
    const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
    const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
    return {
      add_date: (addSwap && addSwap.swap_date) || '',
      drop_date: (dropSwap && dropSwap.swap_date) || '',
    };
  }

  // The span a no-longer-active player was rostered for inside THIS week. No add_date here means
  // they carried in from an earlier week, so the span opens at the week start — it used to render
  // as a bare "?", which is now common enough to matter (every mid-week swap produces one).
  function commDroppedSpanTag(player) {
    const dates = getPlayerDates(player);
    if (!dates.add_date && !dates.drop_date) return ' <span class="wrs-hist-tag">not rostered</span>';
    const start = dates.add_date || weekStart;
    const startLabel = start ? fmtSlashDate(start) : '?';
    const endLabel = dates.drop_date ? fmtSlashDate(dates.drop_date) : 'now';
    return ` <span class="wrs-hist-tag">${startLabel}–${endLabel}</span>`;
  }

  function commDateTag(player) {
    const dates = getPlayerDates(player);
    const weekDates = scheduleDates && scheduleDates[weekIdx] ? scheduleDates[weekIdx] : null;
    const start = dates.add_date || (weekDates ? weekDates.start : null);
    const end = dates.drop_date || (weekDates ? weekDates.end : null);
    if (!start || !end) return '';
    const hasSwap = !!(dates.add_date || dates.drop_date);
    // A date still ahead of today belongs to a scheduled swap that hasn't taken effect.
    const scheduled = dates.add_date > commToday || dates.drop_date > commToday;
    const cls = `roster-date-tag${hasSwap ? ' roster-date-swap' : ''}${scheduled ? ' roster-date-scheduled' : ''}`;
    return ` <span class="${cls}">${fmtDateRangeShort(start, end)}</span>`;
  }

  // ---- Batters Table ----
  const batStatMap = {};
  allWeekBatting.forEach((b) => {
    batStatMap[b.batter] = b;
  });
  // Pool filter: only show batting stats for players in historicalBatters (already pool-validated)
  const weekBattingForTable = allWeekBatting.filter((b) => historicalBatters.has(b.batter));
  const commCurrentBatRoster = new Set(roster.batters.filter((p) => !commDroppedThisWeek.has(p)));
  const allBattersThisWeek = new Set([
    ...commCurrentBatRoster,
    ...droppedBatters,
    ...weekBattingForTable
      .filter((b) => commCurrentBatRoster.has(b.batter) || (b.weekly_score || 0) > 0)
      .map((b) => b.batter),
  ]);
  // Include null-manager records for historical players (stats that arrived after a drop)
  const batTotal = allWeekBatting
    .filter((b) => historicalBatters.has(b.batter))
    .reduce((s, b) => s + (b.weekly_score || 0), 0);

  // A scheduled add is listed but not yet counted — the roster is still the pre-swap one.
  const commActiveBatCount = roster.batters.filter((p) => !commDroppedThisWeek.has(p) && !commPendingAdd.has(p)).length;
  let batHtml = `<div class="wrs-group-label">BATTERS (${commActiveBatCount}) <span class="wrs-group-pts">${fmt(Math.round(batTotal * 100) / 100)} pts</span></div>`;

  if (allBattersThisWeek.size > 0) {
    batHtml +=
      '<div class="table-wrapper"><table class="data-table compact-table wrs-table comm-roster-table"><thead><tr>';
    batHtml +=
      '<th>Player</th><th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th><th></th>';
    batHtml += '</tr></thead><tbody>';
    // Same swap-chain ordering as the scoreboard / My Roster tables: keep a swapped-in batter
    // right beneath the batter he replaced so commissioners can trace a swap at a glance.
    const commBatScoreByPlayer = {};
    allBattersThisWeek.forEach((p) => (commBatScoreByPlayer[p] = (batStatMap[p] || {}).weekly_score || 0));
    orderWithSwapChains([...allBattersThisWeek], commBatScoreByPlayer, approvedSwaps, managerName).forEach((batter) => {
      const s = batStatMap[batter] || {};
      // canDrop keys off raw array membership so a commissioner can still cancel a scheduled add;
      // onRoster is the as-of-today status that drives the greying and the date tag.
      const canDrop = roster.batters.includes(batter) && !commDroppedThisWeek.has(batter);
      const isScheduled = commPendingAdd.has(batter);
      const onRoster = canDrop && !isScheduled;
      const wkRank = weekRanks.batRanks[batter];
      const cumScore = commBatCum[batter] || 0;
      const cumRank = cumRankings.batRanks[batter];
      const safeB = jsStr(batter);
      const manual = (f) => ((s.manual_fields || []).includes(f) ? ' stat-manual' : '');
      const pDates = getPlayerDates(batter);
      const batDroppedTag = commDroppedSpanTag(batter);
      batHtml += `<tr${isScheduled ? ' class="wrs-sched-row"' : onRoster ? '' : ' class="wrs-hist-row"'}>`;
      batHtml += `<td>${displayPlayer(batter, sd)}${isScheduled || onRoster ? commDateTag(batter) : batDroppedTag}</td>`;
      batHtml += `<td class="num${manual('abs')}">${s.abs || 0}</td>`;
      batHtml += `<td class="num${manual('1b')}">${s['1b'] || 0}</td>`;
      batHtml += `<td class="num${manual('2b')}">${s['2b'] || 0}</td>`;
      batHtml += `<td class="num${manual('3b')}">${s['3b'] || 0}</td>`;
      batHtml += `<td class="num${manual('hr')}">${s.hr || 0}</td>`;
      batHtml += `<td class="num${manual('r')}">${s.r || 0}</td>`;
      batHtml += `<td class="num${manual('rbi')}">${s.rbi || 0}</td>`;
      batHtml += `<td class="num${manual('sb')}">${s.sb || 0}</td>`;
      batHtml += `<td class="num${manual('bb')}">${s.bb || 0}</td>`;
      batHtml += `<td class="num"><strong>${fmt(s.weekly_score || 0)}</strong></td>`;
      batHtml += `<td class="num rank-cell">${wkRank ? wkRank.rank + '/' + wkRank.total : '-'}</td>`;
      batHtml += `<td class="num"><strong>${fmt(cumScore)}</strong></td>`;
      batHtml += `<td class="num rank-cell">${cumRank ? cumRank.rank + '/' + cumRank.total : '-'}</td>`;
      batHtml += `<td style="white-space:nowrap;">`;
      batHtml += `<button class="btn btn-sm btn-outline" onclick="editPlayerStats('${safeMgr}','batting','${safeB}','${weekKey}')">Edit</button> `;
      if (canDrop) {
        batHtml += `<button class="btn btn-sm btn-danger" onclick="removeFromRoster('${safeMgr}','batters','${safeB}','${weekKey}')">Drop</button> `;
      }
      batHtml += `<button class="btn btn-sm btn-warning" onclick="hardRemoveFromRoster('${safeMgr}','batters','${safeB}','${weekKey}')">Remove</button>`;
      batHtml += `</td></tr>`;
      // Date editor row
      const dateRowId = `pdate-bat-${batter.replace(/[^a-zA-Z0-9]/g, '_')}`;
      batHtml += `<tr class="comm-date-row"><td colspan="15">`;
      batHtml += `<div class="comm-player-dates">`;
      batHtml += `<label>Add Date</label><input type="date" class="form-select comm-date-input" id="${dateRowId}-add" value="${pDates.add_date}">`;
      batHtml += `<label>Drop Date</label><input type="date" class="form-select comm-date-input" id="${dateRowId}-drop" value="${pDates.drop_date}">`;
      batHtml += `<button class="btn btn-sm btn-primary" onclick="savePlayerDates('${safeMgr}','${safeB}','${weekKey}','${dateRowId}')">Save</button>`;
      batHtml += `</div></td></tr>`;
    });
    batHtml += `</tbody><tfoot><tr class="wrs-subtotal-row">
      <td colspan="9"></td>
      <td class="wrs-subtotal-label">Batting Total</td>
      <td class="num wrs-subtotal-val"><strong>${fmt(Math.round(batTotal * 100) / 100)}</strong></td>
      <td colspan="4"></td>
    </tr></tfoot></table></div>`;
  } else {
    batHtml += '<p class="text-muted" style="font-size:0.82rem;">No batters rostered this week.</p>';
  }
  document.getElementById('comm-roster-batters').innerHTML = batHtml;

  // ---- Pitchers Table ----
  const pitStatMap = {};
  allWeekPitching.forEach((p) => {
    pitStatMap[p.pitcher] = p;
  });
  const weekPitchingForTable = allWeekPitching.filter((p) => historicalPitchers.has(p.pitcher));
  const commCurrentPitRoster = new Set(roster.pitchers.filter((p) => !commDroppedThisWeek.has(p)));
  const allPitchersThisWeek = new Set([
    ...commCurrentPitRoster,
    ...droppedPitchers,
    ...weekPitchingForTable
      .filter((p) => commCurrentPitRoster.has(p.pitcher) || (p.weekly_score || 0) > 0)
      .map((p) => p.pitcher),
  ]);
  // Include null-manager records for historical players (stats that arrived after a drop)
  const pitTotal = allWeekPitching
    .filter((p) => historicalPitchers.has(p.pitcher))
    .reduce((s, p) => s + (p.weekly_score || 0), 0);

  const commActivePitCount = roster.pitchers.filter(
    (p) => !commDroppedThisWeek.has(p) && !commPendingAdd.has(p)
  ).length;
  let pitHtml = `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${commActivePitCount}) <span class="wrs-group-pts">${fmt(Math.round(pitTotal * 100) / 100)} pts</span></div>`;

  if (allPitchersThisWeek.size > 0) {
    pitHtml +=
      '<div class="table-wrapper"><table class="data-table compact-table wrs-table comm-roster-table"><thead><tr>';
    pitHtml +=
      '<th>Player</th><th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th><th></th>';
    pitHtml += '</tr></thead><tbody>';
    // Swap-chain ordering, same as the batter table above.
    const commPitScoreByPlayer = {};
    allPitchersThisWeek.forEach((p) => (commPitScoreByPlayer[p] = (pitStatMap[p] || {}).weekly_score || 0));
    orderWithSwapChains([...allPitchersThisWeek], commPitScoreByPlayer, approvedSwaps, managerName).forEach(
      (pitcher) => {
        const s = pitStatMap[pitcher] || {};
        const canDrop = roster.pitchers.includes(pitcher) && !commDroppedThisWeek.has(pitcher);
        const isScheduled = commPendingAdd.has(pitcher);
        const onRoster = canDrop && !isScheduled;
        const wkRank = weekRanks.pitRanks[pitcher];
        const cumScore = commPitCum[pitcher] || 0;
        const cumRank = cumRankings.pitRanks[pitcher];
        const safeP = jsStr(pitcher);
        const manual = (f) => ((s.manual_fields || []).includes(f) ? ' stat-manual' : '');
        const pDates = getPlayerDates(pitcher);
        const pitDroppedTag = commDroppedSpanTag(pitcher);
        pitHtml += `<tr${isScheduled ? ' class="wrs-sched-row"' : onRoster ? '' : ' class="wrs-hist-row"'}>`;
        pitHtml += `<td>${displayPlayer(pitcher, sd)}${isScheduled || onRoster ? commDateTag(pitcher) : pitDroppedTag}</td>`;
        pitHtml += `<td class="num${manual('gs')}">${s.gs || 0}</td>`;
        pitHtml += `<td class="num${manual('w')}">${s.w || 0}</td>`;
        pitHtml += `<td class="num${manual('qs')}">${s.qs != null ? fmtDec(s.qs) : 0}</td>`;
        pitHtml += `<td class="num${manual('cg')}">${s.cg || 0}</td>`;
        pitHtml += `<td class="num${manual('cgso')}">${s.cgso || 0}</td>`;
        pitHtml += `<td class="num${manual('nh')}">${s.nh || 0}</td>`;
        pitHtml += `<td class="num${manual('ip')}">${fmtDec(s.ip || 0)}</td>`;
        pitHtml += `<td class="num${manual('h')}">${s.h || 0}</td>`;
        pitHtml += `<td class="num${manual('er')}">${s.er || 0}</td>`;
        pitHtml += `<td class="num${manual('bb')}">${s.bb || 0}</td>`;
        pitHtml += `<td class="num${manual('k')}">${s.k || 0}</td>`;
        pitHtml += `<td class="num"><strong>${fmt(s.weekly_score || 0)}</strong></td>`;
        pitHtml += `<td class="num rank-cell">${wkRank ? wkRank.rank + '/' + wkRank.total : '-'}</td>`;
        pitHtml += `<td class="num"><strong>${fmt(cumScore)}</strong></td>`;
        pitHtml += `<td class="num rank-cell">${cumRank ? cumRank.rank + '/' + cumRank.total : '-'}</td>`;
        pitHtml += `<td style="white-space:nowrap;">`;
        pitHtml += `<button class="btn btn-sm btn-outline" onclick="editPlayerStats('${safeMgr}','pitching','${safeP}','${weekKey}')">Edit</button> `;
        if (canDrop) {
          pitHtml += `<button class="btn btn-sm btn-danger" onclick="removeFromRoster('${safeMgr}','pitchers','${safeP}','${weekKey}')">Drop</button> `;
        }
        pitHtml += `<button class="btn btn-sm btn-warning" onclick="hardRemoveFromRoster('${safeMgr}','pitchers','${safeP}','${weekKey}')">Remove</button>`;
        pitHtml += `</td></tr>`;
        // Date editor row
        const dateRowId = `pdate-pit-${pitcher.replace(/[^a-zA-Z0-9]/g, '_')}`;
        pitHtml += `<tr class="comm-date-row"><td colspan="17">`;
        pitHtml += `<div class="comm-player-dates">`;
        pitHtml += `<label>Add Date</label><input type="date" class="form-select comm-date-input" id="${dateRowId}-add" value="${pDates.add_date}">`;
        pitHtml += `<label>Drop Date</label><input type="date" class="form-select comm-date-input" id="${dateRowId}-drop" value="${pDates.drop_date}">`;
        pitHtml += `<button class="btn btn-sm btn-primary" onclick="savePlayerDates('${safeMgr}','${safeP}','${weekKey}','${dateRowId}')">Save</button>`;
        pitHtml += `</div></td></tr>`;
      }
    );
    pitHtml += `</tbody><tfoot><tr class="wrs-subtotal-row">
      <td colspan="11"></td>
      <td class="wrs-subtotal-label">Pitching Total</td>
      <td class="num wrs-subtotal-val"><strong>${fmt(Math.round(pitTotal * 100) / 100)}</strong></td>
      <td colspan="4"></td>
    </tr></tfoot></table></div>`;
  } else {
    pitHtml += '<p class="text-muted" style="font-size:0.82rem;">No pitchers rostered this week.</p>';
  }
  document.getElementById('comm-roster-pitchers').innerHTML = pitHtml;

  // Week total
  const weekTotal = Math.round((batTotal + pitTotal) * 100) / 100;
  const totalContainer = document.getElementById('comm-roster-total');
  if (totalContainer) {
    totalContainer.innerHTML = `<div class="wrs-week-total">
      <span>Week Total</span>
      <span><strong>${fmt(weekTotal)}</strong></span>
    </div>`;
  }

  // Re-setup search inputs for the new week
  setupPlayerSearchInputs();
};

window.savePlayerDates = function (manager, player, weekKey, dateRowId) {
  const addInput = document.getElementById(dateRowId + '-add');
  const dropInput = document.getElementById(dateRowId + '-drop');
  if (!addInput || !dropInput) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  if (!sd.roster_dates) sd.roster_dates = {};
  if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
  if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
  if (!sd.roster_dates[manager][weekKey][player]) sd.roster_dates[manager][weekKey][player] = {};

  sd.roster_dates[manager][weekKey][player].add_date = addInput.value || '';
  sd.roster_dates[manager][weekKey][player].drop_date = dropInput.value || '';

  saveSeason(SELECTED_SEASON, sd);

  // Refresh the commissioner view to show updated tags
  window.updateCommRosterWeekView(manager);
};

window.commAddPlayer = function (manager, type) {
  const inputId = type === 'batters' ? 'comm-add-bat' : 'comm-add-pit';
  const input = document.getElementById(inputId);
  const weekSelect = document.getElementById('comm-roster-week');
  if (!input || !weekSelect) return;
  const weekKey = weekSelect.value;
  if (!weekKey) return;
  window.addToRosterFromSearch(manager, type, inputId, weekKey);
  // Refresh the view
  setTimeout(() => window.updateCommRosterWeekView(manager), 100);
};

window.addToRoster = function (manager, type, selectId, weekKey) {
  const select = document.getElementById(selectId);
  const player = select.value;
  if (!player || !weekKey) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];

  // Enforce pool membership: a player from the batters pool can only be added as a batter,
  // and a player from the pitchers pool can only be added as a pitcher. For two-way players
  // (e.g. Shohei Ohtani), the batter and pitcher versions have distinct names in each pool
  // and are treated as entirely separate entities.
  const battersPool = sd.batters_pool || [];
  const pitchersPool = sd.pitchers_pool || [];
  if (type === 'batters' && battersPool.length > 0 && !battersPool.includes(player)) {
    alert(`${player} is not in the batters pool and cannot be added as a batter.`);
    return;
  }
  if (type === 'pitchers' && pitchersPool.length > 0 && !pitchersPool.includes(player)) {
    alert(`${player} is not in the pitchers pool and cannot be added as a pitcher.`);
    return;
  }

  if (!sd.rosters) sd.rosters = {};
  if (!sd.rosters[manager]) sd.rosters[manager] = {};
  if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };

  const rosterKey = type;
  if (!sd.rosters[manager][weekKey][rosterKey].includes(player)) {
    sd.rosters[manager][weekKey][rosterKey].push(player);

    // Auto-assign any unattributed weekly stat records for this player+week
    const [round, week] = weekKey.split('|');
    const nameKey = rosterKey === 'batters' ? 'batter' : 'pitcher';
    const weeklyArr = rosterKey === 'batters' ? sd.weekly_batting || [] : sd.weekly_pitching || [];
    weeklyArr.forEach((rec) => {
      if (rec[nameKey] === player && rec.round === round && rec.week === week && !rec.manager) {
        rec.manager = manager;
      }
    });

    // Store add date in roster_dates.  Default to today for in-progress weeks, but
    // clamp to the week's start when adding to a week that has already ended — otherwise
    // the daily-stat cutoff zeros the player's score for the entire week.
    const todayStr = new Date().toISOString().split('T')[0];
    const scheduleDatesForAdd = getScheduleDates();
    const weekIdxForAdd = SEASON_SCHEDULE.findIndex((s) => `${s.round}|${s.week}` === weekKey);
    const weekEndForAdd =
      weekIdxForAdd >= 0 && scheduleDatesForAdd && scheduleDatesForAdd[weekIdxForAdd]
        ? scheduleDatesForAdd[weekIdxForAdd].end
        : null;
    const weekStartForAdd =
      weekIdxForAdd >= 0 && scheduleDatesForAdd && scheduleDatesForAdd[weekIdxForAdd]
        ? scheduleDatesForAdd[weekIdxForAdd].start
        : null;
    let effectiveAddDate = todayStr;
    if (weekEndForAdd && todayStr > weekEndForAdd && weekStartForAdd) effectiveAddDate = weekStartForAdd;

    if (!sd.roster_dates) sd.roster_dates = {};
    if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
    if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
    if (!sd.roster_dates[manager][weekKey][player]) sd.roster_dates[manager][weekKey][player] = {};
    sd.roster_dates[manager][weekKey][player].add_date = effectiveAddDate;

    // Create swap log entry for the add
    if (!sd.swaps) sd.swaps = [];
    sd.swaps.push({
      id: Date.now().toString(),
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      email: LOGGED_IN_EMAIL || COMMISSIONER_EMAIL || '',
      manager: manager,
      player_out: null,
      player_in: player,
      reason: 'Commissioner Add',
      swap_date: effectiveAddDate,
      week_key: weekKey,
      status: 'approved',
    });

    saveSeason(SELECTED_SEASON, sd);
  }

  renderRosterData(manager, true);
};

// Remove a player from a specific week's roster
window.removeFromRoster = function (manager, type, player, weekKey) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.rosters || !sd.rosters[manager] || !sd.rosters[manager][weekKey]) return;

  sd.rosters[manager][weekKey][type] = (sd.rosters[manager][weekKey][type] || []).filter((p) => p !== player);

  // Store drop date in roster_dates
  if (!sd.roster_dates) sd.roster_dates = {};
  if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
  if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
  if (!sd.roster_dates[manager][weekKey][player]) sd.roster_dates[manager][weekKey][player] = {};
  sd.roster_dates[manager][weekKey][player].drop_date = new Date().toISOString().split('T')[0];

  // Freeze the player's current stats so future syncs don't accumulate more points
  const [round, week] = weekKey.split('|');
  const nameField = type === 'batters' ? 'batter' : 'pitcher';
  const weeklyArr = type === 'batters' ? sd.weekly_batting : sd.weekly_pitching;
  if (weeklyArr) {
    const rec = weeklyArr.find(
      (r) => r[nameField] === player && (r.manager === manager || !r.manager) && r.round === round && r.week === week
    );
    if (rec) {
      rec.drop_locked = true;
      // Ensure the manager is attributed so the score counts toward team totals
      if (!rec.manager) rec.manager = manager;
    }
  }

  // Create swap log entry for the drop
  if (!sd.swaps) sd.swaps = [];
  sd.swaps.push({
    id: Date.now().toString(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    email: LOGGED_IN_EMAIL || COMMISSIONER_EMAIL || '',
    manager: manager,
    player_out: player,
    player_in: null,
    reason: 'Drop Swap',
    swap_date: new Date().toISOString().split('T')[0],
    week_key: weekKey,
    status: 'approved',
  });

  saveSeason(SELECTED_SEASON, sd);
  renderRosterData(manager, true);
};

// Permanently removes a player from the roster AND erases their stats for the week.
// Use when a player was erroneously rostered (e.g. pre-season submission later changed)
// and their attributed stats need to be purged entirely, not just marked as dropped.
window.hardRemoveFromRoster = async function (manager, type, player, weekKey) {
  if (
    !confirm(
      `Remove ${player} and all their stats for this week from ${manager}'s roster?\n\nThis deletes their stats permanently and cannot be undone.`
    )
  ) {
    return;
  }

  // Persist the removal through the atomic endpoint, NOT the full-season save. A hard remove is a
  // deletion, and the server's stale-save guards re-append any roster_dates entry / weekly stat row
  // missing from a full-season payload — silently resurrecting the removed player after a refresh.
  // The endpoint deletes them on the server's authoritative copy so the removal actually sticks.
  let removed = false;
  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/roster-remove`, {
      method: 'POST',
      body: JSON.stringify({ manager, weekKey, player, type }),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      adoptRev(data._rev);
      removed = true;
    } else {
      const err = await resp.json().catch(() => ({}));
      alert(`Remove failed (${err.error || resp.status}). Please reload and try again.`);
    }
  } catch (e) {
    alert(`Remove failed — ${e.message}. Please reload and try again.`);
  }
  if (!removed) return;

  // Mirror the server's mutation into the local cache so the view updates without a reload.
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (sd) {
    const [round, week] = weekKey.split('|');
    if (sd.rosters && sd.rosters[manager] && sd.rosters[manager][weekKey] && sd.rosters[manager][weekKey][type]) {
      sd.rosters[manager][weekKey][type] = sd.rosters[manager][weekKey][type].filter((p) => p !== player);
    }
    if (sd.weekly_batting) {
      sd.weekly_batting = sd.weekly_batting.filter(
        (b) => !(b.batter === player && b.round === round && b.week === week && (b.manager === manager || !b.manager))
      );
    }
    if (sd.weekly_pitching) {
      sd.weekly_pitching = sd.weekly_pitching.filter(
        (p) => !(p.pitcher === player && p.round === round && p.week === week && (p.manager === manager || !p.manager))
      );
    }
    if (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) {
      delete sd.roster_dates[manager][weekKey][player];
    }
    setSeasonsLocal(seasons);
  }

  renderRosterData(manager, true);
};

// ---- Player Pool Upload ----

// Merge an incoming rows array ([{name, team}]) into an existing pool array + team map.
// Handles same-name players on different teams by storing them as "Name (TEAM)" keys.
// Returns { pool, teamMap, added } where added is a list of newly inserted keys.
function mergePlayerPool(existingPool, existingTeamMap, rows) {
  // Count how many times each base name appears in the CSV rows
  const csvNameCounts = {};
  for (const { name } of rows) csvNameCounts[name] = (csvNameCounts[name] || 0) + 1;

  // Build list of (storageKey, team) per row.
  // When a name appears more than once AND has a team, use "Name (TEAM)" as the key
  // so both players survive as distinct entries.
  const csvEntries = [];
  const csvKeySeen = new Set();
  for (const { name, team } of rows) {
    const key = csvNameCounts[name] > 1 && team ? `${name} (${team})` : name;
    if (!csvKeySeen.has(key)) {
      csvKeySeen.add(key);
      csvEntries.push({ key, team, base: name });
    }
  }

  // Identify existing plain-name entries that need to be renamed because a same-name
  // conflict is incoming (e.g., existing has "Max Muncy", CSV has "Max Muncy (LAD)" + "Max Muncy (ATH)").
  const renames = new Map(); // oldKey -> newKey
  for (const { key, base } of csvEntries) {
    if (key !== base && existingPool.includes(base)) {
      const existingTeam = existingTeamMap[base];
      if (existingTeam && !existingPool.includes(`${base} (${existingTeam})`)) {
        renames.set(base, `${base} (${existingTeam})`);
      }
    }
  }

  // Build the new pool: deduplicate existing (applying renames), then append new entries.
  const seen = new Set();
  const newPool = [];
  const newTeamMap = Object.assign({}, existingTeamMap);
  for (const name of existingPool) {
    const renamed = renames.get(name) || name;
    if (seen.has(renamed)) continue;
    seen.add(renamed);
    newPool.push(renamed);
    if (renames.has(name)) {
      newTeamMap[renamed] = newTeamMap[name];
      delete newTeamMap[name];
    }
  }

  const added = [];
  for (const { key, team } of csvEntries) {
    if (!seen.has(key)) {
      seen.add(key);
      newPool.push(key);
      added.push(key);
    }
    if (team) newTeamMap[key] = team;
  }

  return { pool: newPool, teamMap: newTeamMap, added, renames };
}

function setupPlayerPoolUploads() {
  document.getElementById('upload-batters-pool-btn').onclick = () => {
    const fileInput = document.getElementById('upload-batters-pool');
    if (!fileInput.files[0]) {
      alert('Select a file first.');
      return;
    }
    parseCSVFile(fileInput.files[0], (names, teamMap, rows) => {
      const seasons = getSeasons();
      const sd = seasons[SELECTED_SEASON];
      const { pool, teamMap: newTeamMap, added } = mergePlayerPool(sd.batters_pool || [], sd.batters_team || {}, rows);
      sd.batters_pool = pool;
      sd.batters_team = newTeamMap;
      setSeasonsLocal(seasons);
      savePool(SELECTED_SEASON, 'batters', pool, newTeamMap);
      const pitCount = (sd.pitchers_pool || []).length;
      const totalBat = pool.length;
      let msg =
        added.length > 0
          ? `<p class="success-text">Added ${added.length} new batter(s) to the pool (${totalBat} total). Team names updated.</p>`
          : `<p class="success-text">No new batters added (${totalBat} already in pool). Team names updated.</p>`;
      if (pitCount > 0) {
        msg += `<p class="success-text">Player pool ready (${totalBat} batters, ${pitCount} pitchers). Managers can now begin their Initial Player Submissions.</p>`;
      } else {
        msg += `<p class="text-muted" style="font-size:0.85rem;">Upload pitchers to complete the player pool and enable Initial Player Submissions.</p>`;
      }
      document.getElementById('player-pool-status').innerHTML = msg;
      renderPlayerPoolDisplay();
      fileInput.value = '';
    });
  };

  document.getElementById('upload-pitchers-pool-btn').onclick = () => {
    const fileInput = document.getElementById('upload-pitchers-pool');
    if (!fileInput.files[0]) {
      alert('Select a file first.');
      return;
    }
    parseCSVFile(fileInput.files[0], (names, teamMap, rows) => {
      const seasons = getSeasons();
      const sd = seasons[SELECTED_SEASON];
      const {
        pool,
        teamMap: newTeamMap,
        added,
      } = mergePlayerPool(sd.pitchers_pool || [], sd.pitchers_team || {}, rows);
      sd.pitchers_pool = pool;
      sd.pitchers_team = newTeamMap;
      setSeasonsLocal(seasons);
      savePool(SELECTED_SEASON, 'pitchers', pool, newTeamMap);
      const batCount = (sd.batters_pool || []).length;
      const totalPit = pool.length;
      let msg =
        added.length > 0
          ? `<p class="success-text">Added ${added.length} new pitcher(s) to the pool (${totalPit} total). Team names updated.</p>`
          : `<p class="success-text">No new pitchers added (${totalPit} already in pool). Team names updated.</p>`;
      if (batCount > 0) {
        msg += `<p class="success-text">Player pool ready (${batCount} batters, ${totalPit} pitchers). Managers can now begin their Initial Player Submissions.</p>`;
      } else {
        msg += `<p class="text-muted" style="font-size:0.85rem;">Upload batters to complete the player pool and enable Initial Player Submissions.</p>`;
      }
      document.getElementById('player-pool-status').innerHTML = msg;
      renderPlayerPoolDisplay();
      fileInput.value = '';
    });
  };
}

function renderPlayerPoolDisplay() {
  const container = document.getElementById('player-pool-display');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];

  if (!sd || sd.status === 'completed') {
    container.innerHTML = '<p>This is a completed season.</p>';
    return;
  }

  const batters = sd.batters_pool || [];
  const pitchers = sd.pitchers_pool || [];

  let html = `<div class="upload-section" style="margin-bottom:1rem;">
    <h3>Pool &amp; Name Cleanup</h3>
    <p class="upload-hint">Checks every player name in this season against the MLB catalog: phantom pool leftovers
    (retired if roster/swap history references them, purged if nothing does), misspelled rostered names
    (auto-renamed and id-claimed), and duplicate-name players needing a manual pick. Scan is read-only.</p>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button class="btn btn-secondary btn-sm" onclick="scanPoolCleanup()">Scan (read-only)</button>
      <button class="btn btn-primary btn-sm" id="pool-cleanup-apply-btn" onclick="applyPoolCleanup()" style="display:none;">Apply fixes</button>
    </div>
    <div id="pool-cleanup-results" style="margin-top:0.75rem;"></div>
  </div>`;

  html += '<div class="two-col">';
  html += '<div>';
  html += `<h3>Batters Pool (${batters.length})</h3>`;
  if (batters.length > 0) {
    html +=
      '<div class="pool-list">' +
      batters.map((n) => `<span class="pool-tag">${displayPlayer(n, sd)}</span>`).join('') +
      '</div>';
  } else {
    html += '<p class="text-muted">No batters uploaded yet.</p>';
  }
  html += '</div>';

  html += '<div>';
  html += `<h3>Pitchers Pool (${pitchers.length})</h3>`;
  if (pitchers.length > 0) {
    html +=
      '<div class="pool-list">' +
      pitchers.map((n) => `<span class="pool-tag">${displayPlayer(n, sd)}</span>`).join('') +
      '</div>';
  } else {
    html += '<p class="text-muted">No pitchers uploaded yet.</p>';
  }
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
}

// ---- Pool & Name Cleanup (commissioner) ----
// Mobile-friendly UI over GET /api/mlb/roster-audit (read-only scan) and
// POST /api/mlb/roster-fix (apply). The fix auto-renames/id-claims rostered names
// with an unambiguous catalog match, retires history-referenced phantom pool
// entries, and purges orphans; duplicate-name id picks stay manual.

// ---- Commissioner To-Do ----
// One aggregated "needs your attention" card at the top of the commissioner panel,
// so pending work isn't scattered across sub-tabs, badges, and buried tools. Items:
//   - pending swap requests and roster submissions awaiting approval (from season data)
//   - player-name audit findings — missing MLB ids, misspellings, phantom pool
//     entries (background GET /api/mlb/roster-audit, cached per page load per season
//     since the audit fetches the MLB catalog; re-checked after a cleanup apply)
//   - daily MLB sync gone stale during a scheduled week (from GET /api/mlb/sync-status)
// Each item deep-links to the tool that resolves it. The async sources are
// best-effort: a failed fetch just leaves that item off the list. To add a new item
// type, push onto `items` in renderCommissionerTodo (sync) or follow the cache +
// re-render pattern (async).
const _todoAuditCache = {}; // year -> { fixable, manual }
const _todoSyncCache = {}; // year -> { newestTs } (null newestTs = no runs recorded)

function renderCommissionerTodo() {
  const el = document.getElementById('comm-todo-card');
  if (!el) return;
  const sd = getSeasons()[SELECTED_SEASON];
  if (!sd) {
    el.style.display = 'none';
    return;
  }
  const items = [];
  const link = (label, onclick) => `<a onclick="${onclick}">${label}</a>`;

  const pendingSwaps = (sd.swaps || []).filter((s) => s.status === 'pending').length;
  if (pendingSwaps) {
    items.push(
      `⚠️ <strong>${pendingSwaps}</strong> pending swap request${pendingSwaps === 1 ? '' : 's'} — ` +
        link('Review', "goToCommTab('comm-tab-swaps','pending-swaps-list')")
    );
  }

  const periods = ['pp1', 'pp2', 'qf', 'sf', 'finals'];
  const pendingSubs = getManagers().reduce(
    (n, m) => n + periods.filter((p) => (getPeriodSub(sd, p, m.name) || {}).status === 'pending').length,
    0
  );
  if (pendingSubs) {
    items.push(
      `⚠️ <strong>${pendingSubs}</strong> roster submission${pendingSubs === 1 ? '' : 's'} awaiting approval — ` +
        link('Review', "goToCommTab('comm-tab-swaps','pending-swaps-list')")
    );
  }

  const audit = _todoAuditCache[SELECTED_SEASON];
  if (audit && audit.fixable + audit.manual > 0) {
    const total = audit.fixable + audit.manual;
    const detail = [
      audit.fixable ? `${audit.fixable} auto-fixable` : null,
      audit.manual ? `${audit.manual} manual review` : null,
    ]
      .filter(Boolean)
      .join(', ');
    items.push(
      `🏷️ <strong>${total}</strong> player name${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} attention ` +
        `(${detail}) — missing MLB ids, misspellings, or phantom pool entries. ` +
        link('Open Pool &amp; Name Cleanup', 'goToPoolCleanup()')
    );
  }

  const sync = _todoSyncCache[SELECTED_SEASON];
  if (sync && sd.status === 'active' && todayInsideScheduledWeek(sd)) {
    const ageMs = sync.newestTs ? Date.now() - parseServerTimestamp(sync.newestTs).getTime() : Infinity;
    if (ageMs > 36 * 60 * 60 * 1000) {
      const last = sync.newestTs ? `last run ${fmtServerTimestamp(sync.newestTs)}` : 'no runs recorded yet';
      items.push(
        `🔄 Daily MLB stat sync looks stale (${last}) — ` +
          link('Check MLB API Sync', "goToCommTab('comm-tab-stats-data','mlb-sync-controls')")
      );
    }
  }

  el.innerHTML =
    `<h2>Commissioner To-Do</h2>` +
    (items.length
      ? `<ul class="comm-todo-list">${items.map((i) => `<li class="comm-todo-item">${i}</li>`).join('')}</ul>`
      : `<p class="comm-todo-allclear">✅ All clear — nothing needs your attention.</p>`);
  el.style.display = 'block';
}

// Async to-do sources: fetch once per page load per season, then re-render the card.
async function refreshTodoAudit(force = false) {
  const year = SELECTED_SEASON;
  if (!force && _todoAuditCache[year]) return;
  try {
    const resp = await apiFetch(`/api/mlb/roster-audit?year=${year}`);
    if (!resp.ok) return;
    const a = await resp.json();
    _todoAuditCache[year] = {
      fixable:
        (a.needs_id_assignment || []).length + (a.unrostered_auto || []).length + (a.unrostered_replace || []).length,
      manual: (a.duplicate_review || []).length + (a.rostered_review || []).length,
    };
    renderCommissionerTodo();
  } catch {
    /* best-effort: leave the item off the list */
  }
}

async function refreshTodoSyncStatus() {
  const year = SELECTED_SEASON;
  if (_todoSyncCache[year]) return;
  try {
    const resp = await apiFetch('/api/mlb/sync-status');
    if (!resp.ok) return;
    const s = await resp.json();
    const newestTs = (s.recent_logs || []).reduce(
      (max, l) => (l.timestamp && (!max || l.timestamp > max) ? l.timestamp : max),
      null
    );
    _todoSyncCache[year] = { newestTs };
    renderCommissionerTodo();
  } catch {
    /* best-effort: leave the item off the list */
  }
}

// True when today (ET) falls inside one of the season's scheduled weeks — the sync
// staleness check is meaningless during the All-Star break or off-season.
function todayInsideScheduledWeek(sd) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return (sd.schedule_dates || []).some((w) => w && w.start && w.end && today >= w.start && today <= w.end);
}

// To-do link target: activate a commissioner sub-tab and scroll to an element in it.
window.goToCommTab = function (tabId, anchorId) {
  const btn = document.querySelector(`.comm-tab-btn[data-comm-tab="${tabId}"]`);
  if (btn) btn.click();
  const anchor = anchorId && document.getElementById(anchorId);
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// To-do link target: open the Season Setup sub-tab, expand the collapsed Initial
// Player Pool section, kick off the read-only scan, and land on the cleanup card.
window.goToPoolCleanup = function () {
  const tabBtn = document.querySelector('.comm-tab-btn[data-comm-tab="comm-tab-season-setup"]');
  if (tabBtn) tabBtn.click();
  const body = document.getElementById('season-setup-body');
  const toggle = document.getElementById('season-setup-toggle');
  if (body && toggle && body.style.display === 'none') toggle.click();
  window.scanPoolCleanup();
  const results = document.getElementById('pool-cleanup-results');
  if (results) results.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.scanPoolCleanup = async function () {
  const out = document.getElementById('pool-cleanup-results');
  const applyBtn = document.getElementById('pool-cleanup-apply-btn');
  if (!out) return;
  out.innerHTML = '<p class="text-muted">Scanning…</p>';
  try {
    const resp = await apiFetch(`/api/mlb/roster-audit?year=${SELECTED_SEASON}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }
    const a = await resp.json();
    const section = (title, items, line) =>
      items && items.length
        ? `<div style="margin-top:0.5rem;"><strong>${title} (${items.length})</strong>
           <ul style="margin:0.25rem 0 0 1.1rem;font-size:0.85rem;">${items.map(line).join('')}</ul></div>`
        : '';
    const auto = a.needs_id_assignment || [];
    const phantoms = [...(a.unrostered_auto || []), ...(a.unrostered_replace || [])];
    const dupes = a.duplicate_review || [];
    const review = a.rostered_review || [];
    let html = '';
    html += section(
      'Rostered — will auto-fix (rename + MLB id)',
      auto,
      (e) => `<li>${esc(e.wmmc_name)} → ${esc(e.mlb_name)}${e.team ? ` (${esc(e.team)})` : ''}</li>`
    );
    html += section(
      'Phantom pool entries — will retire (history kept) or purge (no history)',
      phantoms,
      (e) =>
        `<li>${esc(e.wmmc_name)}${e.mlb_name ? ` <span class="text-muted">(closest MLB: ${esc(e.mlb_name)})</span>` : ''}</li>`
    );
    html += section(
      'Duplicate names — manual id pick required (not auto-fixed)',
      dupes,
      (e) =>
        `<li>${esc(e.wmmc_name)}: ${(e.candidates || [])
          .map((c) => `${esc(c.mlb_name)} (${esc(c.team || '?')}, id ${c.mlb_id})`)
          .join(' / ')}</li>`
    );
    html += section(
      'Rostered, low-confidence match — manual review (not auto-fixed)',
      review,
      (e) =>
        `<li>${esc(e.wmmc_name)} <span class="text-muted">(best: ${esc(e.best_match || '—')}, ${Math.round((e.best_score || 0) * 100)}%)</span></li>`
    );
    if (!html) html = '<p class="success-text">All player names check out — nothing to fix.</p>';
    out.innerHTML = html;
    if (applyBtn) applyBtn.style.display = auto.length || phantoms.length ? 'inline-block' : 'none';
  } catch (e) {
    out.innerHTML = `<p class="error-text">Scan failed — ${esc(e.message)}</p>`;
  }
};

window.applyPoolCleanup = async function () {
  const out = document.getElementById('pool-cleanup-results');
  if (!out) return;
  if (
    !confirm(
      'Apply name fixes?\n\nRostered mismatches are renamed and id-claimed, phantom pool entries are retired or purged. Duplicate-name picks are left for manual review.'
    )
  ) {
    return;
  }
  out.innerHTML = '<p class="text-muted">Applying…</p>';
  try {
    const resp = await apiFetch('/api/mlb/roster-fix', {
      method: 'POST',
      body: JSON.stringify({ year: SELECTED_SEASON }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }
    const r = await resp.json();
    // Pools/rosters changed server-side — refresh the local cache, then re-render
    // (which rebuilds this card, so re-acquire the results div afterwards).
    await syncFromServer();
    renderPlayerPoolDisplay();
    const s = r.summary || {};
    const li = (label, n) => `<li>${label}: <strong>${n || 0}</strong></li>`;
    let html = `<p class="success-text">Cleanup applied.</p>
      <ul style="margin:0.25rem 0 0 1.1rem;font-size:0.85rem;">
        ${li('Renames', s.renames_applied)}
        ${li('MLB ids assigned', s.ids_assigned)}
        ${li('Retired from pool (history kept)', s.players_retired)}
        ${li('Purged (no history)', s.players_purged)}
        ${li('Still needs manual review', s.needs_manual_review)}
      </ul>`;
    if ((r.totals_moved || []).length) {
      html += `<div style="margin-top:0.5rem;"><strong>Manager totals changed</strong> (previously uncredited stats now counting):
        <ul style="margin:0.25rem 0 0 1.1rem;font-size:0.85rem;">${r.totals_moved
          .map(
            (t) =>
              `<li>${esc(t.manager)}: ${fmt(t.before)} → ${fmt(t.after)} (${t.delta > 0 ? '+' : ''}${t.delta})</li>`
          )
          .join('')}</ul></div>`;
    } else {
      html += '<p class="text-muted" style="font-size:0.85rem;">No manager totals moved.</p>';
    }
    const out2 = document.getElementById('pool-cleanup-results');
    if (out2) out2.innerHTML = html;
    // Re-audit so the to-do card clears (or narrows to what's still manual).
    refreshTodoAudit(true);
  } catch (e) {
    const outErr = document.getElementById('pool-cleanup-results');
    if (outErr) outErr.innerHTML = `<p class="error-text">Apply failed — ${esc(e.message)}</p>`;
  }
};

// ---- Weekly Stat Uploads ----

// (assignUnclaimedStats moved server-side as assignUnclaimedStatsServer — the swap approval that
// used it now runs atomically in POST /api/seasons/:year/swaps/:id/approve. See ROSTER_OPS_PLAN.md.)

// Helper: find which manager owns a player via roster assignments
// Search all weeks for a player (fallback when no specific week is known)
function findManagerForPlayer(seasonData, playerName, type) {
  const rosters = seasonData.rosters || {};
  const rosterKey = type === 'batting' ? 'batters' : 'pitchers';
  const lc = String(playerName).toLowerCase();
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    for (const weekRoster of Object.values(mgrRoster)) {
      if ((weekRoster[rosterKey] || []).some((p) => p.toLowerCase() === lc)) {
        return managerName;
      }
    }
  }
  return null;
}

// Bracket-stage labels, used by the roast repair actions and the Hall of Fame season card.
// Distinct from the `ROUND_LABELS` in js/scoring.js, which is keyed by SCORING round (PP1/PP2
// separately) — a bracket stage is keyed by playoff round, where Pool Play is one thing.
const BRACKET_STAGE_LABELS = { PP: 'Pool Play', QF: 'Quarterfinals', SF: 'Semifinals', Finals: 'Finals' };

// The two commissioner roast-repair buttons, for any round that has already been roasted.
// Both exist for the same reason: the roast bank and the page-context builder change over
// time, and a round that was roasted under the old code has no other way back. Regenerate
// touches only the stored roasts (roster pages); repost also sends the combined message.
function roastRepairToolsHtml(round) {
  const label = BRACKET_STAGE_LABELS[round] || round;
  const repostWhat =
    round === 'PP'
      ? 'reposts the combined playoff-field + Hall of Shame message'
      : 'reposts the combined results + Hall of Shame message';
  return `<div style="margin-top:0.5rem;">
      <button class="btn btn-sm btn-secondary" onclick="regenerateRoundRoasts('${round}')">Regenerate Roasts (No Slack Post)</button>
      <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Re-rolls every ${esc(label)} roast in place. Does NOT post to Slack &mdash; roasts just update on managers' roster pages.</span>
    </div>
    <div style="margin-top:0.5rem;">
      <button class="btn btn-sm btn-secondary" onclick="repostRoundRoasts('${round}')">Regenerate &amp; Repost Roasts to Slack</button>
      <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Re-rolls every ${esc(label)} roast and ${repostWhat} to the scoreboard channel.</span>
    </div>`;
}

// Who this round's Hall of Shame is. `sd.eliminated` is the authoritative record — every
// finalize/dump path writes it, and it reflects any commissioner correction made since —
// so a repair action reads it rather than recomputing the bracket, which could disagree.
// Stored roasts are folded in as a fallback for the window where a dump wrote roasts but
// the eliminated map didn't land; podium finishers are excluded (they have their own set).
function eliminatedInRound(sd, round) {
  const set = new Set();
  for (const [m, r] of Object.entries((sd && sd.eliminated) || {})) if (r === round) set.add(m);
  for (const [m, r] of Object.entries((sd && sd.roasts) || {})) {
    if (r && r.round === round && (r.outcome || 'eliminated') === 'eliminated') set.add(m);
  }
  return [...set].sort();
}

// Finals only: the three podium finishers (next year's pool-selection captains), read back
// from their stored roast `outcome` so a repost can never reshuffle who was crowned.
const PODIUM_ORDER = { champion: 0, runner_up: 1, third: 2 };
function podiumRolesFromRoasts(sd) {
  return Object.entries((sd && sd.roasts) || {})
    .filter(([, r]) => r && r.round === 'Finals' && PODIUM_ORDER[r.outcome] !== undefined)
    .map(([manager, r]) => ({ manager, outcome: r.outcome }))
    .sort((a, b) => PODIUM_ORDER[a.outcome] - PODIUM_ORDER[b.outcome]);
}

function renderWeeklyUploadSections() {
  const container = document.getElementById('weekly-upload-sections');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];

  if (!sd || sd.status === 'completed') {
    container.innerHTML = '<p>This is a completed season. No uploads needed.</p>';
    return;
  }

  // Migrate rosters to per-week format if needed
  migrateRostersToWeekly(sd);

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const uploadLog = sd.upload_log || [];

  const uploadedBatting = new Set();
  const uploadedPitching = new Set();
  batting.forEach((b) => uploadedBatting.add(`${b.round}|${b.week}`));
  pitching.forEach((p) => uploadedPitching.add(`${p.round}|${p.week}`));

  // Determine the "current" week: first week without complete data, or last week with data
  let currentWeekIndex = 0;
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const wk = `${SEASON_SCHEDULE[i].round}|${SEASON_SCHEDULE[i].week}`;
    if (uploadedBatting.has(wk) || uploadedPitching.has(wk)) {
      currentWeekIndex = i;
    }
  }
  // The next incomplete week is one after the last with data
  const nextWeekIndex = Math.min(currentWeekIndex + 1, SEASON_SCHEDULE.length - 1);

  const dates = getScheduleDates();
  let html = '';

  // Show All / Hide All buttons
  html += `<div style="margin-bottom:0.75rem;display:flex;gap:0.5rem;">
    <button class="btn btn-sm btn-secondary" onclick="toggleAllUploadWeeks(true)">Show All</button>
    <button class="btn btn-sm btn-secondary" onclick="toggleAllUploadWeeks(false)">Hide All</button>
  </div>`;

  SEASON_SCHEDULE.forEach((s, i) => {
    const weekKey = `${s.round}|${s.week}`;
    const hasBatting = uploadedBatting.has(weekKey);
    const hasPitching = uploadedPitching.has(weekKey);
    const isComplete = hasBatting && hasPitching;
    const dateStr = dates && dates[i] ? fmtDateRangeShort(dates[i].start, dates[i].end) : '';

    // Check if this week has a prior week for Advance Players
    const hasPriorWeek = i > 0;

    // Auto-collapse: show current and next week expanded, collapse completed past weeks
    const isCurrentOrNext = i >= currentWeekIndex && i <= nextWeekIndex;
    const isExpanded = isCurrentOrNext;

    html += `
      <div class="weekly-upload-block ${isComplete ? 'upload-complete' : ''}">
        <div class="weekly-upload-header upload-week-toggle" onclick="toggleUploadWeek(${i})" style="cursor:pointer;">
          <h3>${s.label}${dateStr ? ` <span class="week-dates-inline">(${dateStr})</span>` : ''}</h3>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span class="badge ${isComplete ? 'badge-winner' : 'badge-wildcard'}">${isComplete ? 'Complete' : 'Pending'}</span>
            <span class="upload-week-chevron" id="upload-chevron-${i}">${isExpanded ? '&#9660;' : '&#9654;'}</span>
          </div>
        </div>
        <div class="upload-week-body" id="upload-week-body-${i}" style="display:${isExpanded ? 'block' : 'none'};">`;

    // Advance Players button (not for the first week, and never across a period boundary —
    // PP2/QF/SF/Finals Week 1 is owned by that period's submissions, so carrying the previous
    // round's rosters in would hand every manager, eliminated ones included, a roster they
    // never submitted. See the CORE SCORING INVARIANT in CLAUDE.md.)
    if (hasPriorWeek && !isPeriodBoundaryWeek(i)) {
      const alreadyAdvanced = (sd.advanced_weeks || []).includes(i);
      const autoAdvanced = (sd.auto_advanced_weeks || []).includes(i);
      const btnDisabled = alreadyAdvanced ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
      const statusText = autoAdvanced
        ? 'Auto-advanced on Sunday'
        : alreadyAdvanced
          ? 'Players already advanced'
          : 'Copy rosters from ' + SEASON_SCHEDULE[i - 1].label;
      html += `<div style="margin:0.5rem 0;">
        <button class="btn btn-sm btn-secondary" onclick="advancePlayers(${i})" ${btnDisabled}>Advance Players</button>
        <span class="text-muted" style="font-size:0.78rem;">${statusText}</span>
        <span id="advance-status-${i}"></span>
      </div>`;
    } else if (hasPriorWeek) {
      html += `<div style="margin:0.5rem 0;">
        <span class="text-muted" style="font-size:0.78rem;">Starts a new submission period &mdash; rosters come from each manager's ${esc(s.round)} submission, not carried forward from ${SEASON_SCHEDULE[i - 1].label}.</span>
      </div>`;
    }

    html += `<div class="two-col" style="margin-top:0.5rem;">
          <div>
            <label class="upload-label">Batters CSV ${hasBatting ? '(uploaded)' : ''}</label>
            <input type="file" id="upload-bat-${i}" accept=".csv" class="weekly-file-input">
            <button class="btn btn-sm btn-primary" onclick="uploadWeeklyBatting(${i})">
              ${hasBatting ? 'Re-upload' : 'Upload'} Batters
            </button>
          </div>
          <div>
            <label class="upload-label">Pitchers CSV ${hasPitching ? '(uploaded)' : ''}</label>
            <input type="file" id="upload-pit-${i}" accept=".csv" class="weekly-file-input">
            <button class="btn btn-sm btn-primary" onclick="uploadWeeklyPitching(${i})">
              ${hasPitching ? 'Re-upload' : 'Upload'} Pitchers
            </button>
          </div>
        </div>
        <div id="upload-status-${i}" class="upload-status"></div>`;

    // End Pool Play / End Round buttons at key transition weeks
    const finalized = sd.finalized_rounds || [];
    if (i === 9) {
      // Week 10 (PP2 Week 5) - End Pool Play
      const ppFinalized = finalized.includes('PP');
      html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm ${ppFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('PP')" ${ppFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${ppFinalized ? 'Pool Play Ended' : 'End Pool Play'}
        </button>
        ${ppFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Pool Play finalized. Managers advanced to Quarterfinals.</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize pool play and advance managers to playoffs.</span>'}
      </div>`;
      if (ppFinalized) html += roastRepairToolsHtml('PP');
    } else if (i === 11) {
      // Week 12 (QF Week 2) - End Quarterfinals
      const qfFinalized = finalized.includes('QF');
      const qfDumped = (sd.losers_dumped || []).includes('QF');
      html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm ${qfFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('QF')" ${qfFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${qfFinalized ? 'Quarterfinals Ended' : 'End Quarterfinals'}
        </button>
        ${qfFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Quarterfinals finalized.</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize quarterfinals and advance winners to semifinals.</span>'}
      </div>`;
      if (qfFinalized && !qfDumped) {
        html += `<div style="margin-top:0.5rem;">
          <button class="btn btn-sm btn-danger" onclick="dumpPlayoffLosers('QF')">Advance SF Winners &amp; Dump QF Loser Rosters</button>
          <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Removes QF losers from SF submissions, marks them eliminated, generates roasts, and posts the Hall of Shame to Slack.</span>
        </div>`;
      } else if (qfDumped) {
        html += `<div style="margin-top:0.5rem;"><span class="success-text" style="font-size:0.78rem;">QF loser rosters dumped. Roasts generated and posted to Slack.</span></div>`;
        html += roastRepairToolsHtml('QF');
      }
    } else if (i === 13) {
      // Week 14 (SF Week 2) - End Semifinals.
      //
      // Unlike the Quarterfinals, this transition dumps NOBODY. The semifinal knocks nobody
      // out of the schedule: its two winners play the Championship and its two losers play
      // the 3rd-place game, and both of those games are contested over the SAME Finals weeks.
      // All four semifinalists therefore submit a Finals roster, and there is no Hall of
      // Shame until the season actually ends. See advanceToFinalsAndThirdPlace.
      const sfFinalized = finalized.includes('SF');
      const sfAdvanced = (sd.losers_dumped || []).includes('SF');
      html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm ${sfFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('SF')" ${sfFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${sfFinalized ? 'Semifinals Ended' : 'End Semifinals'}
        </button>
        ${sfFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Semifinals finalized.</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize semifinals and advance winners to the Finals and losers to the 3rd-place game.</span>'}
      </div>`;
      if (sfFinalized) {
        html += `<div style="margin-top:0.5rem;">
          <button class="btn btn-sm btn-accent" onclick="advanceToFinalsAndThirdPlace()">${sfAdvanced ? 'Repost' : 'Post'} Semifinal Results &amp; Finals/3rd-Place Preview</button>
          <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Posts the semifinal results and a preview of both Finals-week games to Slack. Nobody is eliminated here &mdash; all four semifinalists keep their Finals submission (two for the Championship, two for the 3rd-place game). Safe to run again.</span>
        </div>`;
        if (sfAdvanced) {
          html += `<div style="margin-top:0.5rem;"><span class="success-text" style="font-size:0.78rem;">Semifinal results and previews posted to Slack.</span></div>`;
        }
      }
    } else if (i === 15) {
      // Week 16 (Finals Week 2) — End Finals & Close Season.
      //
      // ONE button, deliberately. This used to be two: "End Finals" wrote a flag, and every
      // visible thing a season ending is supposed to produce — the four roasts, the Hall of
      // Shame post — sat behind a second button that only appeared afterwards. A season ended
      // with neither, because nobody knew to press it. The whole close is one action now, and
      // it is re-runnable, which is what the second button underneath is for.
      const closed = sd.season_closed && sd.season_closed.at;
      if (!closed) {
        const finalsFinalized = finalized.includes('Finals');
        html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm btn-accent" onclick="endFinalsAndCloseSeason()">End Finals &amp; Close Season</button>
        <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">
          Crowns the champion, roasts all four Finals-week managers, posts the Hall of Shame and the season recap to Slack, and turns off every scheduled job &mdash; no more daily syncs, Slack posts or MLB polling.
        </span>
      </div>`;
        if (finalsFinalized) {
          html += `<div style="margin-top:0.5rem;"><span class="text-muted" style="font-size:0.78rem;">The Finals round is already marked finalized, but the season has not been closed &mdash; run this to finish it.</span></div>`;
        }
      } else {
        const closedOn = fmtServerTimestamp(sd.season_closed.at);
        const recap = sd.season_closed.recap || {};
        const recapNote = recap.posted
          ? `Season recap posted${recap.source ? ` (written by ${esc(String(recap.source))})` : ''}.`
          : `Season recap did NOT post${recap.error ? `: ${esc(String(recap.error))}` : ''}. Re-run to try again.`;
        html += `<div style="margin-top:0.75rem;">
        <span class="success-text" style="font-size:0.78rem;">Season closed ${esc(closedOn)}. Champion: ${esc(sd.season_closed.champion || '?')}. All scheduled jobs are off.</span>
        <div class="${recap.posted ? 'text-muted' : 'error-text'}" style="font-size:0.78rem;margin-top:0.25rem;">${recapNote}</div>
      </div>
      <div style="margin-top:0.5rem;">
        <button class="btn btn-sm btn-secondary" onclick="rerunSeasonClose()">Re-run Season Close</button>
        <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Re-rolls all four Finals roasts, reposts the Hall of Shame <em>and</em> the season recap, and re-asserts the shutdown. Safe to run again.</span>
      </div>
      <div style="margin-top:0.5rem;">
        <button class="btn btn-sm btn-danger" onclick="reopenSeason()">Reopen Season</button>
        <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Turns the scheduled jobs back on (daily sync, 7am Slack post, auto-advance, live scoring). Nothing about the roasts, the recap or the standings changes.</span>
      </div>`;
        html += roastRepairToolsHtml('Finals');
      }
    }

    // Clear week data button (only when data exists)
    if (hasBatting || hasPitching) {
      html += `<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border,#e0e0e0);">
        <button class="btn btn-sm btn-danger" onclick="clearWeekData(${i})">Clear All Data for This Week</button>
        <span class="text-muted" style="font-size:0.78rem;margin-left:0.5rem;">Removes all batting and pitching records for ${s.label}</span>
      </div>`;
    }

    // Upload log for this week
    const weekLogs = uploadLog.filter((l) => l.round === s.round && l.week === s.week);
    if (weekLogs.length > 0) {
      const logId = `upload-log-entries-${i}`;
      html += '<div class="upload-log">';
      html += `<div style="display:flex;align-items:center;gap:0.5rem;">
        <span class="upload-log-label" style="margin:0;">Upload History</span>
        <button class="btn btn-sm btn-secondary" onclick="var el=document.getElementById('${logId}');el.style.display=el.style.display==='none'?'block':'none';this.textContent=this.textContent==='Show'?'Hide':'Show';" style="font-size:0.7rem;padding:0.1rem 0.4rem;">Show</button>
      </div>`;
      html += `<div id="${logId}" style="display:none;">`;
      weekLogs
        .slice()
        .reverse()
        .forEach((l) => {
          const typeLabel = l.type === 'batting' ? 'Batting' : 'Pitching';
          const typeBadgeColor = l.type === 'batting' ? 'var(--accent,#6c63ff)' : 'var(--success,#28a745)';
          html += `<div class="upload-log-entry">
          <span class="upload-log-time">${fmtServerTimestamp(l.timestamp)}</span>
          <span class="swap-badge" style="background:${typeBadgeColor};color:#fff;font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:4px;">${typeLabel}</span>
          <span class="upload-log-detail">${l.rows} records &mdash; ${l.assigned} assigned, ${l.unassigned} unassigned</span>
        </div>`;
        });
      html += '</div></div>';
    }

    html += `</div></div>`; // close .upload-week-body and .weekly-upload-block
  });

  container.innerHTML = html;
}

window.toggleUploadWeek = function (weekIndex) {
  const body = document.getElementById(`upload-week-body-${weekIndex}`);
  const chevron = document.getElementById(`upload-chevron-${weekIndex}`);
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  if (chevron) chevron.innerHTML = hidden ? '&#9660;' : '&#9654;';
};

window.toggleAllUploadWeeks = function (show) {
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const body = document.getElementById(`upload-week-body-${i}`);
    const chevron = document.getElementById(`upload-chevron-${i}`);
    if (body) body.style.display = show ? 'block' : 'none';
    if (chevron) chevron.innerHTML = show ? '&#9660;' : '&#9654;';
  }
};

window.clearWeekData = async function (weekIndex) {
  const s = SEASON_SCHEDULE[weekIndex];
  if (!s) return;
  const confirmed = confirm(
    `Clear ALL batting and pitching data for ${s.label}?\n\nThis will permanently delete all records for this week, whether from manual uploads or Google Sheets sync. This cannot be undone.`
  );
  if (!confirmed) return;

  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/week-data`, {
      method: 'DELETE',
      body: JSON.stringify({ round: s.round, week: s.week }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to clear data');

    // Update local state
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (sd) {
      sd.weekly_batting = (sd.weekly_batting || []).filter((b) => !(b.round === s.round && b.week === s.week));
      sd.weekly_pitching = (sd.weekly_pitching || []).filter((p) => !(p.round === s.round && p.week === s.week));
      seasons[SELECTED_SEASON] = sd;
      setSeasonsLocal(seasons);
    }

    renderWeeklyUploadSections();
    const statusEl = document.getElementById(`upload-status-${weekIndex}`);
    if (statusEl) {
      statusEl.innerHTML = `<span class="success-text">Cleared ${data.batting_removed} batting and ${data.pitching_removed} pitching records.</span>`;
    }
  } catch (e) {
    alert(`Error clearing week data: ${e.message}`);
  }
};

// True when week `i` is the first week of a new scoring period (PP2/QF/SF/Finals Week 1).
// Mirror of server.js' isPeriodBoundaryWeek — keep the two in step.
function isPeriodBoundaryWeek(i) {
  return (
    i > 0 && SEASON_SCHEDULE[i] && SEASON_SCHEDULE[i - 1] && SEASON_SCHEDULE[i].round !== SEASON_SCHEDULE[i - 1].round
  );
}

// Copy per-week rosters from the prior week into `weekIndex` for all active managers and create
// the zero-stat weekly rows those players need, marking the week advanced so it can't run twice.
//
// Pure mutator on the `sd` it is handed — the CALLER owns the save. That split is the fix for the
// round-advance clobber: finalizeRound used to read its own getSeasons() snapshot, then call an
// advancePlayers that read a SECOND independent snapshot, mutated it and saved it, after which
// finalizeRound saved its now-stale first snapshot on top. Two full-season payloads from one
// click, the later one missing the rosters the earlier one had just written — which rewound the
// local cache, tripped the server's destructive-save guard ("roster shrank B 4→0"), and left
// finalized_rounds unwritten. One snapshot, one save.
//
// Returns { ok, advanced, reason }; reason is 'boundary' | 'already' | 'invalid' when ok is false.
function applyAdvancePlayers(sd, weekIndex) {
  if (!sd || weekIndex < 1) return { ok: false, advanced: 0, reason: 'invalid' };

  // CORE SCORING INVARIANT: a new submission period starts fresh from its own submission —
  // players never carry across a period boundary. Advancing into PP2/QF/SF/Finals Week 1 would
  // give every manager holding a prior-round roster (eliminated managers included) players they
  // never submitted, which is exactly what purge-orphan-boundary-rosters exists to clean up.
  if (isPeriodBoundaryWeek(weekIndex)) return { ok: false, advanced: 0, reason: 'boundary' };

  // Prevent double-click
  if (!sd.advanced_weeks) sd.advanced_weeks = [];
  if (sd.advanced_weeks.includes(weekIndex)) return { ok: false, advanced: 0, reason: 'already' };

  migrateRostersToWeekly(sd);

  const priorSched = SEASON_SCHEDULE[weekIndex - 1];
  const currentSched = SEASON_SCHEDULE[weekIndex];
  const priorKey = `${priorSched.round}|${priorSched.week}`;
  const currentKey = `${currentSched.round}|${currentSched.week}`;

  if (!sd.rosters) sd.rosters = {};
  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];
  let advanced = 0;

  // Build a set of players dropped during or before the prior week
  const swaps = sd.swaps || [];

  // Pre-compute cumulative batting totals per player (from all prior uploaded weeks)
  // so zero-stat records for the new week can carry the correct running total
  const existingBatTotals = {};
  (sd.weekly_batting || []).forEach((b) => {
    if (b.batter) {
      existingBatTotals[b.batter] = (existingBatTotals[b.batter] || 0) + (b.weekly_score || 0);
    }
  });

  const managers = getManagers().filter((m) => m.active !== false);
  managers.forEach((m) => {
    if (!sd.rosters[m.name]) sd.rosters[m.name] = {};
    const priorRoster = sd.rosters[m.name][priorKey];
    if (priorRoster) {
      // Filter out dropped players: only advance players still on the prior week's roster
      // (removeFromRoster removes from the weekKey's array, so priorRoster is already correct)
      // Also filter out any player that was dropped (player_out) in ANY week up to and including priorKey
      const droppedBatters = new Set();
      const droppedPitchers = new Set();
      swaps
        .filter((s) => s.manager === m.name && s.status === 'approved' && s.player_out && !s.player_in)
        .forEach((s) => {
          // If this drop was for the prior week or current week, exclude the player
          if (s.week_key === priorKey || s.week_key === currentKey) {
            droppedBatters.add(s.player_out);
            droppedPitchers.add(s.player_out);
          }
        });

      const batters = (priorRoster.batters || []).filter((p) => !droppedBatters.has(p));
      const pitchers = (priorRoster.pitchers || []).filter((p) => !droppedPitchers.has(p));

      // Copy roster to current week (don't overwrite existing)
      if (!sd.rosters[m.name][currentKey]) {
        sd.rosters[m.name][currentKey] = { batters, pitchers };

        // Create zero-stat batting records for advanced players
        batters.forEach((batter) => {
          const exists = sd.weekly_batting.some(
            (b) =>
              b.round === currentSched.round &&
              b.week === currentSched.week &&
              b.batter === batter &&
              b.manager === m.name
          );
          if (!exists) {
            sd.weekly_batting.push({
              round: currentSched.round,
              week: currentSched.week,
              manager: m.name,
              batter,
              abs: 0,
              '1b': 0,
              '2b': 0,
              '3b': 0,
              hr: 0,
              r: 0,
              rbi: 0,
              sb: 0,
              bb: 0,
              weekly_score: 0,
              total_score: existingBatTotals[batter] || 0,
            });
          }
        });

        // Create zero-stat pitching records for advanced players
        pitchers.forEach((pitcher) => {
          const exists = sd.weekly_pitching.some(
            (p) =>
              p.round === currentSched.round &&
              p.week === currentSched.week &&
              p.pitcher === pitcher &&
              p.manager === m.name
          );
          if (!exists) {
            sd.weekly_pitching.push({
              round: currentSched.round,
              week: currentSched.week,
              manager: m.name,
              pitcher,
              gs: 0,
              w: 0,
              qs: 0,
              cg: 0,
              cgso: 0,
              nh: 0,
              ip: 0,
              h: 0,
              er: 0,
              bb: 0,
              k: 0,
              weekly_score: 0,
            });
          }
        });

        advanced++;
      }
    }
  });

  // Mark this week as advanced
  sd.advanced_weeks.push(weekIndex);
  return { ok: true, advanced, reason: null };
}

// Commissioner "Advance Players" button: read one snapshot, apply, save it, report.
window.advancePlayers = async function (weekIndex) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const setStatus = (cls, txt) => {
    const el = document.getElementById(`advance-status-${weekIndex}`);
    if (el) el.innerHTML = `<span class="${cls}" style="font-size:0.78rem;"> ${txt}</span>`;
  };

  const result = applyAdvancePlayers(sd, weekIndex);
  if (!result.ok) {
    if (result.reason === 'already') setStatus('text-muted', 'Players already advanced for this week.');
    else if (result.reason === 'boundary') {
      setStatus(
        'text-muted',
        `${esc(SEASON_SCHEDULE[weekIndex].round)} starts a new submission period — rosters come from each manager's submission, not from the previous round.`
      );
    }
    return;
  }

  // saveSeason already alerts (and reloads) on a rejected save; leave the status line alone so a
  // failure never reads as a success.
  if (!(await saveSeason(SELECTED_SEASON, sd))) return;

  setStatus(
    result.advanced > 0 ? 'success-text' : 'text-muted',
    result.advanced > 0
      ? `Advanced ${result.advanced} manager roster${result.advanced > 1 ? 's' : ''}.`
      : 'All rosters already set for this week.'
  );
  renderWeeklyUploadSections();
};

// Finalize a round (End Pool Play, End QF, End SF, End Finals).
//
// Every branch mutates ONE `sd` snapshot and writes it with ONE awaited save. Nothing re-renders
// until that save is confirmed, so a rejected save leaves the button live and honest instead of
// showing a finalized round the server never accepted.
//
// The next round is deliberately NOT roster-advanced here. QF/SF/Finals Week 1 each open a new
// submission period, and players never carry across a period boundary (CORE SCORING INVARIANT) —
// those rosters come from each manager's submission for the round. The follow-up "Advance
// winners & dump loser rosters" button is what prunes the losers and posts the round-end Slack.
window.finalizeRound = async function (roundKey) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  if (!sd.finalized_rounds) sd.finalized_rounds = [];
  if (sd.finalized_rounds.includes(roundKey)) return;

  sd.finalized_rounds.push(roundKey);

  // Lock in the playoff seeds at the moment pool play is confirmed. From here on the bracket
  // and qualification read this snapshot, so a later pool-play stat correction can't silently
  // reseed an in-progress playoff.
  let qualifiers = [];
  let nonQualifiers = [];
  if (roundKey === 'PP') {
    const snapshot = buildSeedingSnapshot(sd);
    if (snapshot) sd.confirmed_seeding = snapshot;
    // Mark pool-play non-qualifiers as eliminated and queue roasts
    qualifiers = getQFQualifiers(sd) || [];
    const allManagers = getManagers().map((m) => m.name);
    nonQualifiers = allManagers.filter((m) => !qualifiers.includes(m));
    if (!sd.eliminated) sd.eliminated = {};
    nonQualifiers.forEach((m) => {
      if (!sd.eliminated[m]) sd.eliminated[m] = 'PP';
    });
  }

  if (!(await saveSeason(SELECTED_SEASON, sd))) return; // saveSeason already alerted/reloaded

  renderWeeklyUploadSections();
  init();

  if (roundKey === 'PP' && nonQualifiers.length > 0) {
    // Generate roasts in the background — sequentially, so concurrent generate-roast
    // read-modify-writes can't clobber each other's stored roast — then post ONE combined
    // Slack message (playoff field + QF matchups, then the roasts) to the scoreboard
    // channel and re-render so roasts appear. `qualifiers` is already seed-ordered.
    for (const m of nonQualifiers) {
      await generateRoastForManager(m, 'PP');
    }
    await postCombinedRoastsToSlack('PP', qualifiers, nonQualifiers);
    renderWeeklyUploadSections();
  }
};

// Remove losing managers' next-round submissions, mark them eliminated, trigger roasts.
//
// QUARTERFINALS ONLY. The semifinal looks like the same transition and is not: its losers play
// the 3rd-place game over the Finals weeks, so nothing of theirs may be dumped and nobody is
// marked eliminated. That transition is advanceToFinalsAndThirdPlace, below.
window.dumpPlayoffLosers = async function (round) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  if (round !== 'QF') {
    alert(
      'Only the quarterfinals eliminate anyone. Use "Post Semifinal Results & Finals/3rd-Place Preview" for the semifinals — all four semifinalists play on.'
    );
    return;
  }
  const nextPeriod = 'sf';

  const qfQualifiers = getQFQualifiers(sd) || [];
  const sfParticipants = getSFParticipants(sd) || [];
  const losers = qfQualifiers.filter((m) => !sfParticipants.includes(m));

  if (losers.length === 0) {
    alert('No losers identified — make sure the round is finalized and scores are uploaded.');
    return;
  }

  // Submissions are server-authoritative: the full-season save always keeps the server's copy of
  // initial_submissions/period_submissions, so deleting them off a local `sd` and saving it was a
  // no-op — the losers' next-round submissions survived every "dump". Remove them through the
  // atomic endpoint instead, which is the only path that actually persists.
  for (const m of losers) {
    if (!(await removeSubmissionRemote(nextPeriod, m))) return; // already alerted
  }

  // Re-read AFTER the deletions: removeSubmissionRemote rewrites the local cache and adopts a new
  // _rev, so the pre-delete snapshot above is stale and would be rejected (or would re-mirror the
  // submissions it just removed).
  const fresh = getSeasons();
  const freshSd = fresh[SELECTED_SEASON];
  if (!freshSd) return;
  if (!freshSd.eliminated) freshSd.eliminated = {};
  losers.forEach((m) => {
    freshSd.eliminated[m] = round;
  });
  freshSd.losers_dumped = freshSd.losers_dumped || [];
  if (!freshSd.losers_dumped.includes(round)) freshSd.losers_dumped.push(round);

  if (!(await saveSeason(SELECTED_SEASON, freshSd))) return; // saveSeason already alerted/reloaded

  for (const m of losers) {
    await generateRoastForManager(m, round);
  }
  // Post the round's eliminations to Slack the same way Pool Play does — one combined
  // message with a roast per eliminated manager. `qualifiers` (the PP playoff-field
  // summary) doesn't apply here; the server only builds that block for round === 'PP'.
  const posted = await postCombinedRoastsToSlack(round, null, losers);
  alert(
    `Dumped ${losers.length} loser roster${losers.length > 1 ? 's' : ''}: ${losers.join(', ')}.` +
      (posted ? ' Posted to Slack.' : ' Slack post failed — check the browser console.')
  );
  renderWeeklyUploadSections();
  init();
};

// The Semifinals → Finals transition. The counterpart to dumpPlayoffLosers, and deliberately
// NOT a dump: losing a semifinal eliminates nobody.
//
// Both Finals-week games are played over the SAME two weeks — the Championship between the SF
// winners and the 3rd-place game between the SF losers — so all four semifinalists need a
// Finals-period roster, and all four keep submitting. Nothing here deletes a submission and
// nothing here writes sd.eliminated; the season's only remaining elimination happens at
// "Crown Champion", where 4th place is settled by the 3rd-place game.
//
// It is also the repair for seasons transitioned before this was understood, which is why it is
// re-runnable and idempotent: it clears any stale sd.eliminated[...] = 'SF' markers (they blocked
// the two 3rd-place managers out of the Finals submission form) and any 'your season is over'
// roast wrongly stored against the SF round (server-authoritative, so it takes an endpoint).
window.advanceToFinalsAndThirdPlace = async function () {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const sfParticipants = getSFParticipants(sd) || [];
  const finalsParticipants = getFinalsParticipants(sd) || [];
  if (sfParticipants.length < 4 || finalsParticipants.length < 2) {
    alert('Finals participants not determined yet — make sure the semifinals are finalized and scores are uploaded.');
    return;
  }
  const thirdPlacePair = sfParticipants.filter((m) => !finalsParticipants.includes(m));

  // Withdraw any SF-round roast first: those were written as eliminations, and they render on
  // the manager's roster page as a "season over" banner while he is still playing.
  const clearedRoasts = await clearRoastsForRound('SF');
  if (clearedRoasts === null) return; // already alerted

  // Re-read after the roast delete adopted a new _rev, so this save isn't rejected as stale.
  const fresh = getSeasons();
  const freshSd = fresh[SELECTED_SEASON];
  if (!freshSd) return;
  const unblocked = [];
  for (const [m, r] of Object.entries(freshSd.eliminated || {})) {
    if (r === 'SF') {
      delete freshSd.eliminated[m];
      unblocked.push(m);
    }
  }
  freshSd.losers_dumped = freshSd.losers_dumped || [];
  if (!freshSd.losers_dumped.includes('SF')) freshSd.losers_dumped.push('SF');

  if (!(await saveSeason(SELECTED_SEASON, freshSd))) return; // saveSeason already alerted/reloaded

  // No roasts to pass: the server builds this post as results + the Finals/3rd-place preview.
  const posted = await postCombinedRoastsToSlack('SF', null, []);
  alert(
    `Finals: ${finalsParticipants.join(' vs ')}. 3rd-place game: ${thirdPlacePair.join(' vs ')}. ` +
      `All four submit a Finals roster.` +
      (unblocked.length ? ` Cleared stale elimination marks for ${unblocked.join(', ')}.` : '') +
      (posted ? ' Posted to Slack.' : ' Slack post failed — check the browser console.')
  );
  renderWeeklyUploadSections();
  init();
};

// Delete every stored roast for a round. sd.roasts is server-authoritative (a full-season save
// can only ADD to it), so this is the only way to withdraw one. Returns the removed managers, or
// null on failure after alerting.
//
// The local mirror is NOT optional here: the server merges an incoming save's roasts UNDER its
// own (`{...incoming, ...stored}`), so a following full-season save still carrying the deleted
// roasts would put every one of them straight back.
async function clearRoastsForRound(round) {
  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/roasts/${round}`, { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(`Could not clear ${round} roasts: ${data.error || resp.status}`);
      return null;
    }
    const removed = data.removed || [];
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (sd && sd.roasts) {
      for (const m of removed) delete sd.roasts[m];
      setSeasonsLocal(seasons);
    }
    adoptRev(data._rev);
    return removed;
  } catch (e) {
    console.error('clearRoastsForRound failed:', e);
    alert(`Could not clear ${round} roasts: ${e.message}`);
    return null;
  }
}

// End the season, in one action.
//
// Everything a season ending is supposed to produce, in the order the league sees it:
//
//   1. Finalize the Finals round server-side, which also records the runner-up and the
//      4th-place manager as eliminated and hands back the authoritative placements.
//   2. A roast for each of the four managers who played the Finals weeks. Only 4th place gets
//      the plain elimination banner — the champion, the runner-up and the 3rd-place winner are
//      next year's pool-selection captains, so they get the podium treatment instead, even
//      though the runner-up lost the same round 4th place did.
//   3. The combined "the season is over" Hall of Shame post.
//   4. The season recap — final standings, superlatives, career notes, a written wrap — and
//      the shutdown: every scheduled job off, no more syncs, Slack posts or MLB polling.
//
// The placements come from the SERVER (`/final-placements`), not from bracket math run here,
// so the podium the roasts are written for and the podium the recap crowns are the same
// answer computed once. Sequential throughout: each generate-roast is a read-modify-write of
// db.json, so concurrent calls would clobber each other's stored roast.
//
// `regenerate` re-rolls every stored roast instead of keeping what is there — the difference
// between the first run and the Re-run button.
async function runSeasonClose({ regenerate = false } = {}) {
  const setBusy = (msg) => {
    const el = document.getElementById('weekly-upload-sections');
    if (el) el.style.opacity = '0.6';
    console.log(`[Season close] ${msg}`);
  };
  const clearBusy = () => {
    const el = document.getElementById('weekly-upload-sections');
    if (el) el.style.opacity = '';
  };

  // A refused stat correction on a completed week blocks the close server-side. It is a real
  // stop — those weeks feed the bracket and the permanent record — but it is the commissioner's
  // call, not ours, so the block is offered as a decision rather than a dead end.
  let force = false;
  const finalize = () =>
    apiFetch(`/api/seasons/${SELECTED_SEASON}/finalize-season`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });

  try {
    setBusy('Finalizing the Finals round…');
    let finResp = await finalize();
    let finData = await finResp.json().catch(() => ({}));
    if (!finResp.ok && finData.force_required) {
      const detail = (finData.correction_flags || [])
        .map((f) => `  • ${f.week} — ${f.managers || 'no manager named'}${f.verdict ? ` (${f.verdict})` : ''}`)
        .join('\n');
      const proceed = confirm(
        `${finData.error}\n\nOutstanding:\n${detail}\n\n` +
          'OK = close the season anyway (the placements and the permanent record will be built on ' +
          'these scores).\nCancel = stop, and resolve the week first.'
      );
      if (!proceed) return false;
      force = true;
      finResp = await finalize();
      finData = await finResp.json().catch(() => ({}));
    }
    if (!finResp.ok) {
      alert(`Could not close the season: ${finData.error || finResp.status}`);
      return false;
    }
    adoptRev(finData._rev);
    const p = finData.placements || {};
    if (!p.champion) {
      alert('Could not determine a champion — make sure the Finals scores are uploaded.');
      return false;
    }

    // Re-sync so the eliminations the server just wrote are in the local cache before any
    // save fired by a re-render can echo a copy that predates them.
    await resyncSeasonsFromServer();

    const podiumRoles = [
      { manager: p.champion, outcome: 'champion' },
      p.runnerUp ? { manager: p.runnerUp, outcome: 'runner_up' } : null,
      p.third ? { manager: p.third, outcome: 'third' } : null,
    ].filter(Boolean);
    const losers = [p.fourth].filter(Boolean);

    setBusy('Writing the roasts…');
    for (const m of losers) await generateRoastForManager(m, 'Finals');
    for (const w of podiumRoles) await generateRoastForManager(w.manager, 'Finals', w.outcome);

    setBusy('Posting the Hall of Shame…');
    const roastsPosted = await postCombinedRoastsToSlack('Finals', null, losers, regenerate, podiumRoles);

    setBusy('Posting the season recap and standing the schedulers down…');
    // Carries the same force decision — /close re-checks the correction flags independently.
    const closeResp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/close`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
    const closeData = await closeResp.json().catch(() => ({}));
    if (!closeResp.ok) {
      alert(
        `Roasts are done, but closing the season failed: ${closeData.error || closeResp.status}\n\n` +
          'The scheduled jobs may still be running. Use "Re-run Season Close" once the problem is fixed.'
      );
      return false;
    }
    adoptRev(closeData._rev);
    await resyncSeasonsFromServer();

    const recap = closeData.recap || {};
    alert(
      `Season closed.\n\nChampion: ${p.champion}\nRunner-up: ${p.runnerUp}\n3rd place: ${p.third}\n4th place: ${p.fourth}\n\n` +
        `Roasts: ${roastsPosted ? 'posted to Slack' : 'POST FAILED — check the browser console'}\n` +
        `Season recap: ${recap.posted ? `posted (written by ${recap.source})${recap.fallback_reason ? ` — fell back to the static bank: ${recap.fallback_reason}` : ''}` : `NOT POSTED${recap.error || closeData.recap_error ? ` — ${recap.error || closeData.recap_error}` : ''}`}\n` +
        `Scheduled jobs: ${closeData.schedulers === 'stood_down' ? 'all off' : 'unchanged (this is not the active season)'}`
    );
    return true;
  } catch (e) {
    console.error('Season close failed:', e);
    alert(`Season close failed: ${e.message}`);
    return false;
  } finally {
    clearBusy();
    renderWeeklyUploadSections();
    init();
  }
}

window.endFinalsAndCloseSeason = async function () {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;
  if (
    !confirm(
      'End the Finals and close the season?\n\nThis crowns the champion, roasts all four Finals-week managers, ' +
        'posts the Hall of Shame and the season recap to Slack, and turns OFF every scheduled job — the daily ' +
        'stat sync, the 7am Slack post, the Sunday auto-advance and live scoring.\n\nIt can be undone with "Reopen Season".'
    )
  ) {
    return;
  }
  await runSeasonClose();
};

// Re-run the whole close. Every step of it is idempotent, so this is the one repair action for
// the lot: a Slack post that failed, a batch of roasts that all came from the static bank, a
// recap written before a late stat correction, or a shutdown that needs re-asserting after the
// season was reopened and closed again.
window.rerunSeasonClose = async function () {
  if (
    !confirm(
      'Re-run the season close?\n\nThis RE-ROLLS all four Finals roasts and posts a NEW Hall of Shame message and a ' +
        'NEW season recap to the scoreboard channel. It cannot edit the messages already there.'
    )
  ) {
    return;
  }
  await runSeasonClose({ regenerate: true });
};

// Turn the scheduled jobs back on. Deliberately touches nothing else: the roasts, the recap and
// the standings stay exactly as they are. Reopening is for "a stat correction is still coming"
// or "I clicked that a week early", not for un-crowning anybody.
window.reopenSeason = async function () {
  if (
    !confirm(
      'Reopen the season?\n\nThe daily stat sync, the 7am Slack post, the Sunday auto-advance and live scoring all ' +
        'start running again. The roasts, the recap and the final standings are left alone.'
    )
  ) {
    return;
  }
  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/reopen`, { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(`Could not reopen the season: ${data.error || resp.status}`);
      return;
    }
    adoptRev(data._rev);
    await resyncSeasonsFromServer();
    alert('Season reopened. All scheduled jobs are running again.');
  } catch (e) {
    console.error('Season reopen failed:', e);
    alert(`Could not reopen the season: ${e.message}`);
  } finally {
    renderWeeklyUploadSections();
    init();
  }
};

// Pull the server's seasons back into the local cache. Every commissioner action that writes
// through an atomic endpoint needs this: the server's copy is authoritative for roasts,
// submissions and the season-close record, and a following full-season save built on a stale
// local copy is how those get rolled back.
async function resyncSeasonsFromServer() {
  try {
    const fresh = await fetch('/api/seasons');
    if (!fresh.ok) return false;
    const serverSeasons = await fresh.json();
    if (serverSeasons && Object.keys(serverSeasons).length > 0) {
      setSeasonsLocal(serverSeasons);
      return true;
    }
  } catch (e) {
    console.error('Season re-sync failed:', e);
  }
  return false;
}

// Call the server to generate and store a roast. `outcome` defaults to the standard
// "you're eliminated" roast; pass 'champion', 'runner_up', or 'third' for the Finals-round
// podium roasts (all three are next year's pool-selection captains).
async function generateRoastForManager(manager, round, outcome) {
  try {
    await apiFetch(`/api/seasons/${SELECTED_SEASON}/generate-roast`, {
      method: 'POST',
      body: JSON.stringify({ manager, round, outcome: outcome || 'eliminated' }),
    });
    // Re-sync seasons from server so roasts appear immediately
    await resyncSeasonsFromServer();
  } catch (e) {
    console.error('Roast generation failed for', manager, e);
  }
}

// Ask the server to post every elimination roast for a round to Slack as one combined
// message on the scoreboard channel, opening with the playoff field. `qualifiers`
// (seed-ordered) and `eliminated` are fallbacks the server uses if the finalize save
// hasn't landed yet; the server generates any missing roast itself before posting.
// `regenerate` re-rolls every stored roast for the round (used by the repost button).
// `podium` (Finals only) is an array of {manager, outcome:'champion'|'runner_up'|'third'}
// — gets its own "word for the podium" section instead of the Hall of Shame one.
// Non-fatal on failure (e.g. Slack webhook not configured) — finalization already succeeded
// and the roasts still show on the roster pages. Returns true when the post went out.
async function postCombinedRoastsToSlack(round, qualifiers, eliminated, regenerate, podium) {
  try {
    const resp = await apiFetch(`/api/seasons/${SELECTED_SEASON}/roasts/slack`, {
      method: 'POST',
      body: JSON.stringify({ round, qualifiers, eliminated, regenerate, podium }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.error('Combined roast Slack post failed:', data.error || resp.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Combined roast Slack post failed for', round, e);
    return false;
  }
}

// Commissioner repair action: re-roll every stored roast for a round server-side WITHOUT
// posting to Slack — for refreshing roasts after the roast bank or the page-context builder
// changes, without sending a second round-end message to the channel. Reuses the same
// per-manager generate-roast call the elimination dump uses, and preserves each manager's
// stored `outcome`, so a champion is re-roasted as a champion and not eliminated.
window.regenerateRoundRoasts = async function (round) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const label = BRACKET_STAGE_LABELS[round] || round;
  const losers = eliminatedInRound(sd, round);
  const podium = round === 'Finals' ? podiumRolesFromRoasts(sd) : [];
  const total = losers.length + podium.length;
  if (total === 0) {
    alert(`No ${label} roasts on file to regenerate.`);
    return;
  }
  if (!confirm(`Regenerate ${total} ${label} roast${total === 1 ? '' : 's'}? This does NOT post anything to Slack.`)) {
    return;
  }

  // Sequential: each generate-roast is a read-modify-write of db.json, so concurrent calls
  // would clobber each other's stored roast.
  for (const m of losers) {
    await generateRoastForManager(m, round);
  }
  for (const w of podium) {
    await generateRoastForManager(w.manager, round, w.outcome);
  }
  alert(`Regenerated ${total} ${label} roast${total === 1 ? '' : 's'}. Nothing was posted to Slack.`);
  renderWeeklyUploadSections();
};

// Commissioner repair action: re-roll every roast for a round server-side AND repost the
// combined Slack message (playoff field or round results, then the Hall of Shame). Covers
// the failure modes of the original post — a roast lost to a stale save, the whole batch
// coming from the static fallback, or the roast build having changed since — without having
// to re-finalize anything. Posts a NEW message; it cannot edit the original.
window.repostRoundRoasts = async function (round) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const label = BRACKET_STAGE_LABELS[round] || round;
  const losers = eliminatedInRound(sd, round);
  const podium = round === 'Finals' ? podiumRolesFromRoasts(sd) : [];
  if (losers.length + podium.length === 0) {
    alert(`No ${label} roasts on file to repost.`);
    return;
  }
  if (!confirm(`Re-roll every ${label} roast and post a NEW combined message to the scoreboard channel?`)) {
    return;
  }

  // `qualifiers` only feeds the PP playoff-field summary; the server builds the playoff
  // rounds' opener from the real matchup scores and ignores it.
  const qualifiers = round === 'PP' ? getQFQualifiers(sd) || [] : null;
  const ok = await postCombinedRoastsToSlack(round, qualifiers, losers, true, podium.length ? podium : undefined);

  // Re-sync so the regenerated roasts show on roster pages immediately.
  await resyncSeasonsFromServer();
  alert(ok ? 'Roasts regenerated and reposted to Slack.' : 'Slack repost failed — check the browser console.');
  renderWeeklyUploadSections();
};

// Show/hide the global submission warning banner below the nav. Sits outside the tab
// sections, so it's visible on every page. Covers EVERY submission window (PP1, PP2,
// QF, SF, Finals): while a period's window is confirmed open and the logged-in manager
// is qualified (and not eliminated), a missing submission warns with a link that jumps
// to that period's submission card on My Roster.
function updateSubmissionWarningBanner() {
  const banner = document.getElementById('submission-warning-banner');
  if (!banner || !LOGGED_IN_EMAIL) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || sd.status !== 'active') {
    banner.style.display = 'none';
    return;
  }

  const managers = getManagers();
  const me = managers.find((m) => m.email && m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase());
  if (!me) {
    banner.style.display = 'none';
    return;
  }

  // SF/Finals "qualification" is open to everyone (see isManagerQualifiedForPeriod) —
  // an eliminated manager is filtered here instead, mirroring the submission card's
  // "Season ended" state so the banner never nags a knocked-out manager. A semifinal
  // loser is NOT knocked out (3rd-place game), so this still nags them for a Finals roster.
  const isEliminatedFor = (period) => isManagerEliminatedForPeriod(sd, me.name, period);

  // Whether a period is LATE is the server's call (SUBMISSION_WINDOWS). Ask in the background and
  // re-run this banner if an answer moved; the TTL cache keeps it from re-asking on every render.
  refreshSubmissionWindows(['pp1', 'pp2', 'qf', 'sf', 'finals'], updateSubmissionWarningBanner);

  // During a between-periods break (e.g. the All-Star break) the upcoming round's
  // window may not have opened yet — windows open the Friday before the round — but
  // the break is exactly when managers think about their next lineup. Warn for the
  // upcoming period through the whole break, noting when submissions open; drop it
  // once that period's deadline has passed.
  const between = getBetweenPeriodsInfo(sd);
  const upcomingPeriod = between ? between.nextRound.toLowerCase() : null;

  const warnings = [];
  for (const period of ['pp1', 'pp2', 'qf', 'sf', 'finals']) {
    let opensAt = null;
    // A period whose lock has passed used to fall out of this loop entirely — the banner went
    // quiet on exactly the manager who most needed it. It now warns louder instead: he can still
    // submit, and every day he waits is a day his roster doesn't score.
    const late = periodIsLate(period) && periodStillRunning(period, getPeriodSub(sd, period, me.name));
    if (!late && !isPeriodWindowConfirmedOpen(sd, period)) {
      if (period !== upcomingPeriod) continue;
      const deadline = getPeriodDeadline(sd, period);
      if (deadline && Date.now() >= deadline.getTime()) continue;
      const openDate = getPeriodOpenDate(sd, period);
      if (openDate && Date.now() < openDate.getTime()) opensAt = openDate;
    }
    if (!isManagerQualifiedForPeriod(me.name, period, sd)) continue;
    if (isEliminatedFor(period)) continue;
    const sub = getPeriodSub(sd, period, me.name);
    if (!sub || (sub.status !== 'pending' && sub.status !== 'approved')) {
      // Named for THIS manager: a semifinal loser is warned about his 3rd-place-game roster,
      // not about a Finals roster he has no game for.
      warnings.push({ period, label: submissionPeriodLabel(sd, period, me.name), opensAt, late });
    }
  }

  if (warnings.length === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.innerHTML = warnings
    .map((w) => {
      // The period lives inside the <strong>: the desktop banner lays the item out
      // with inline-flex, so a bare trailing "." would become its own flex item
      // with a stray gap before it.
      if (w.late) {
        const eff = periodEffectiveDate(w.period);
        const effNote = eff
          ? ` You can still submit &mdash; it would count from <strong>${fmtEffectiveDate(eff)}.</strong>`
          : ' Only the commissioner can still back-date it.';
        return (
          `<span class="sub-warn-item">⏰ You missed the <strong>${w.label}</strong> roster deadline.${effNote}` +
          ` <a href="#" onclick="goToSubmission('${w.period}');return false;">Submit late &rarr;</a></span>`
        );
      }
      const opensNote = w.opensAt
        ? ` Submissions open <strong>${w.opensAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.</strong>`
        : '';
      const linkText = w.opensAt ? 'View submission page' : 'Submit your lineup';
      return (
        `<span class="sub-warn-item">⚠️ Your <strong>${w.label}</strong> lineup is not submitted.${opensNote}` +
        ` <a href="#" onclick="goToSubmission('${w.period}');return false;">${linkText} &rarr;</a></span>`
      );
    })
    .join('');
  banner.style.display = 'flex';
}

// Jump from the warning banner to a period's submission card: activate the My Roster
// tab (its click handler re-syncs from the server and re-renders asynchronously), then
// poll for the card, switch to the Swaps roster sub-tab that hosts the submission
// cards, and scroll to it. Polling is needed because the tab render is async.
window.goToSubmission = function (period) {
  const navBtn = document.querySelector('.nav-btn[data-tab="my-roster"]');
  if (navBtn) navBtn.click();
  const targetId = `period-submission-card-${period}`;
  let tries = 0;
  const timer = setInterval(() => {
    const el = document.getElementById(targetId);
    if (el) {
      clearInterval(timer);
      // The submission cards live inside the "Swaps" roster sub-tab — activate it
      // (no-op if already active) so the card is actually visible before scrolling.
      const swapsTab = document.querySelector('.roster-tab[data-rtab="swaps"]');
      if (swapsTab && !swapsTab.classList.contains('active')) swapsTab.click();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight so the eye lands on the right card after the jump.
      el.classList.add('submission-card-flash');
      setTimeout(() => el.classList.remove('submission-card-flash'), 2400);
    } else if (++tries > 40) {
      clearInterval(timer);
    }
  }, 150);
};

window.uploadWeeklyBatting = function (weekIndex) {
  const scheduleWeek = SEASON_SCHEDULE[weekIndex];
  const fileInput = document.getElementById(`upload-bat-${weekIndex}`);
  if (!fileInput.files[0]) {
    alert('Select a file first.');
    return;
  }

  parseCSVFileWithStats(fileInput.files[0], (rows) => {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd.weekly_batting) sd.weekly_batting = [];

    // Preserve records that have manually edited fields
    const manualBatRecords = sd.weekly_batting.filter(
      (b) =>
        b.round === scheduleWeek.round && b.week === scheduleWeek.week && b.manual_fields && b.manual_fields.length > 0
    );

    sd.weekly_batting = sd.weekly_batting.filter(
      (b) =>
        !(b.round === scheduleWeek.round && b.week === scheduleWeek.week) ||
        (b.manual_fields && b.manual_fields.length > 0)
    );

    const batterTotals = {};
    sd.weekly_batting.forEach((b) => {
      if (!batterTotals[b.batter]) batterTotals[b.batter] = 0;
      batterTotals[b.batter] += b.weekly_score || 0;
    });

    let imported = 0;
    let skipped = 0;
    rows.forEach((row) => {
      const batter = findColumn(row, ['batter', 'player', 'name']);
      if (!batter) return;

      // Resolve manager: use week-specific roster lookup first, then fallback
      let manager = findManagerForPlayerWeek(sd, batter, 'batting', scheduleWeek.round, scheduleWeek.week);
      if (!manager) manager = findManagerForPlayer(sd, batter, 'batting');
      if (!manager) manager = findColumn(row, ['manager', 'owner']);
      const isUnassigned = !manager;

      // Combine BB + IBB + HBP into the BB scoring category
      const bbVal = parseNum(row['bb'] || row['BB'] || row['walks'] || 0);
      const ibbVal = parseNum(row['ibb'] || row['IBB'] || 0);
      const hbpVal = parseNum(row['hbp'] || row['HBP'] || 0);

      const stats = {
        '1b': parseNum(row['1b'] || row['1B'] || row['singles'] || 0),
        '2b': parseNum(row['2b'] || row['2B'] || row['doubles'] || 0),
        '3b': parseNum(row['3b'] || row['3B'] || row['triples'] || 0),
        hr: parseNum(row['hr'] || row['HR'] || row['home_runs'] || row['homeRuns'] || 0),
        r: parseNum(row['r'] || row['R'] || row['runs'] || 0),
        rbi: parseNum(row['rbi'] || row['RBI'] || 0),
        sb: parseNum(row['sb'] || row['SB'] || row['stolen_bases'] || row['stolenBases'] || 0),
        bb: bbVal + ibbVal + hbpVal,
        abs: parseNum(row['ab'] || row['AB'] || row['abs'] || row['atBats'] || 0),
      };

      // Check if this player has a manually-edited record for this week
      const manualRecord = manualBatRecords.find((m) => m.batter === batter && m.manager === (manager || null));
      if (manualRecord) {
        // Merge: keep manual fields from existing record, use upload for non-manual fields
        const manualFields = manualRecord.manual_fields || [];
        const statKeys = ['abs', '1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb'];
        statKeys.forEach((k) => {
          if (!manualFields.includes(k)) {
            manualRecord[k] = stats[k]; // update non-manual fields from upload
          }
        });
        // Recalculate score after merging
        manualRecord.weekly_score = calculateBattingScore(manualRecord);
        manualRecord.status = manualRecord.status || row['status'] || row['Status'] || null;
        imported++;
        return;
      }

      const weeklyScore = calculateBattingScore(stats);
      const previousTotal = batterTotals[batter] || 0;

      sd.weekly_batting.push({
        round: scheduleWeek.round,
        week: scheduleWeek.week,
        manager: manager || null,
        batter: batter,
        status: row['status'] || row['Status'] || null,
        ...stats,
        weekly_score: weeklyScore,
        total_score: Math.round((previousTotal + weeklyScore) * 100) / 100,
      });
      if (isUnassigned) skipped++;
      else imported++;
    });

    // Log the upload event
    if (!sd.upload_log) sd.upload_log = [];
    sd.upload_log.push({
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      type: 'batting',
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      rows: imported + skipped,
      assigned: imported,
      unassigned: skipped,
    });

    saveSeason(SELECTED_SEASON, sd);
    let statusMsg = `Uploaded ${imported} batter records. Scores calculated.`;
    if (skipped > 0) {
      statusMsg += ` ${skipped} players unrostered (stats stored, will be assigned when added to a roster).`;
    }
    document.getElementById(`upload-status-${weekIndex}`).innerHTML = `<p class="success-text">${statusMsg}</p>`;
    renderWeeklyUploadSections();
    fileInput.value = '';
    init();
  });
};

window.uploadWeeklyPitching = function (weekIndex) {
  const scheduleWeek = SEASON_SCHEDULE[weekIndex];
  const fileInput = document.getElementById(`upload-pit-${weekIndex}`);
  if (!fileInput.files[0]) {
    alert('Select a file first.');
    return;
  }

  parseCSVFileWithStats(fileInput.files[0], (rows) => {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd.weekly_pitching) sd.weekly_pitching = [];

    // Preserve records that have manually edited fields
    const manualPitRecords = sd.weekly_pitching.filter(
      (p) =>
        p.round === scheduleWeek.round && p.week === scheduleWeek.week && p.manual_fields && p.manual_fields.length > 0
    );

    sd.weekly_pitching = sd.weekly_pitching.filter(
      (p) =>
        !(p.round === scheduleWeek.round && p.week === scheduleWeek.week) ||
        (p.manual_fields && p.manual_fields.length > 0)
    );

    let imported = 0;
    let skipped = 0;
    rows.forEach((row) => {
      const pitcher = findColumn(row, ['pitcher', 'player', 'name']);
      if (!pitcher) return;

      // Resolve manager: use week-specific roster lookup first, then fallback
      let manager = findManagerForPlayerWeek(sd, pitcher, 'pitching', scheduleWeek.round, scheduleWeek.week);
      if (!manager) manager = findManagerForPlayer(sd, pitcher, 'pitching');
      if (!manager) manager = findColumn(row, ['manager', 'owner']);
      const isUnassigned = !manager;

      // Convert IP: ".1" -> .33, ".2" -> .66 (representing 1/3 and 2/3 of an inning)
      const rawIP = parseNum(row['ip'] || row['IP'] || 0);
      const convertedIP = convertIP(rawIP);

      // Combine BB + IBB + HBP into the BB scoring category
      const pitBBVal = parseNum(row['bb'] || row['BB'] || row['walks'] || 0);
      const pitIBBVal = parseNum(row['ibb'] || row['IBB'] || 0);
      const pitHBPVal = parseNum(row['hbp'] || row['HBP'] || 0);

      const gsVal = parseNum(row['gs'] || row['GS'] || 0);
      const erVal = parseNum(row['er'] || row['ER'] || 0);

      // Calculate QS: 1 GS, 5+ IP, 2 or fewer ER = 1 QS; 2+ GS = highlight (null)
      let qsVal;
      if (gsVal === 1 && convertedIP >= 5 && erVal <= 2) {
        qsVal = 1;
      } else if (gsVal >= 2) {
        qsVal = null; // will be highlighted yellow in display
      } else {
        qsVal = 0;
      }

      const stats = {
        gs: gsVal,
        w: parseNum(row['w'] || row['W'] || row['wins'] || 0),
        qs: qsVal,
        cg: parseNum(row['cg'] || row['CG'] || 0),
        cgso: parseNum(row['cgso'] || row['CGSO'] || 0),
        nh: parseNum(row['nh'] || row['NH'] || 0),
        ip: convertedIP,
        h: parseNum(row['h'] || row['H'] || row['hits'] || 0),
        er: erVal,
        bb: pitBBVal + pitIBBVal + pitHBPVal,
        k: parseNum(row['k'] || row['K'] || row['so'] || row['SO'] || row['strikeouts'] || 0),
      };

      // Check if this player has a manually-edited record for this week
      const manualRecord = manualPitRecords.find((m) => m.pitcher === pitcher && m.manager === (manager || null));
      if (manualRecord) {
        // Merge: keep manual fields from existing record, use upload for non-manual fields
        const manualFields = manualRecord.manual_fields || [];
        const statKeys = ['gs', 'w', 'qs', 'cg', 'cgso', 'nh', 'ip', 'h', 'er', 'bb', 'k'];
        statKeys.forEach((k) => {
          if (!manualFields.includes(k)) {
            manualRecord[k] = stats[k]; // update non-manual fields from upload
          }
        });
        // Recalculate score after merging
        manualRecord.weekly_score = calculatePitchingScore(manualRecord);
        manualRecord.status = manualRecord.status || row['status'] || row['Status'] || null;
        imported++;
        return;
      }

      const weeklyScore = calculatePitchingScore(stats);

      sd.weekly_pitching.push({
        round: scheduleWeek.round,
        week: scheduleWeek.week,
        manager: manager || null,
        pitcher: pitcher,
        status: row['status'] || row['Status'] || null,
        ...stats,
        weekly_score: weeklyScore,
      });
      if (isUnassigned) skipped++;
      else imported++;
    });

    // Log the upload event
    if (!sd.upload_log) sd.upload_log = [];
    sd.upload_log.push({
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      type: 'pitching',
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      rows: imported + skipped,
      assigned: imported,
      unassigned: skipped,
    });

    saveSeason(SELECTED_SEASON, sd);
    let statusMsg = `Uploaded ${imported} pitcher records. Scores calculated.`;
    if (skipped > 0) {
      statusMsg += ` ${skipped} players unrostered (stats stored, will be assigned when added to a roster).`;
    }
    document.getElementById(`upload-status-${weekIndex}`).innerHTML = `<p class="success-text">${statusMsg}</p>`;
    renderWeeklyUploadSections();
    fileInput.value = '';
    init();
  });
};

// ============================================================
// CSV Parsing Helpers
// ============================================================
function parseCSVFile(file, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      alert('CSV file appears empty.');
      return;
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
    const nameCol = headers.findIndex(
      (h) =>
        h === 'name' || h === 'player' || h === 'player_name' || h === 'playername' || h === 'batter' || h === 'pitcher'
    );
    const teamCol = headers.findIndex(
      (h) => h === 'team' || h === 'tm' || h === 'team_abbrev' || h === 'abbreviation' || h === 'abbrev'
    );

    const names = [];
    const teamMap = {};
    const rows = []; // [{name, team}] preserving duplicates for same-name players
    const col = nameCol === -1 ? 0 : nameCol;
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols[col] && cols[col].trim()) {
        const name = cols[col].trim();
        const team =
          teamCol !== -1 && cols[teamCol] && cols[teamCol].trim() ? cols[teamCol].trim().toUpperCase() : null;
        names.push(name);
        rows.push({ name, team });
        if (team) teamMap[name] = team; // last team wins for legacy callers
      }
    }
    callback(names, teamMap, rows);
  };
  reader.readAsText(file);
}

function parseCSVFileWithStats(file, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      alert('CSV file appears empty.');
      return;
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.trim());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, j) => {
        row[h] = (cols[j] || '').trim();
      });
      rows.push(row);
    }
    callback(rows);
  };
  reader.readAsText(file);
}

// parseCSVLine, findColumn, parseNum live in js/csv.js + js/utils.js (loaded
// via window globals by js/index.js).

// ============================================================
// Hall of Fame
// ============================================================

// WMMC_HISTORICAL_RESULTS — the authoritative record of every finished season — now lives in
// js/history.js (loaded onto window by js/index.js), because the Slack playoff commentary needs
// the same table server-side. Add a new entry there each year after the Finals are finalized.

// Number of historical seasons (2018-2025 = 8 seasons).
// Number of historical seasons (2018-2025 = 8 seasons).
// Stephen Farmer played 2018-2019 (2 seasons), Joey Auclair joined in 2019 (7 seasons),
// Edgar Rivas joined in 2020 (6 seasons). All other managers played all 8 seasons.
const WMMC_TOTAL_SEASONS_THROUGH_2025 = 8;
// Per-manager season overrides for managers who didn't play every historical season
const WMMC_SEASON_OVERRIDES = { 'Stephen Farmer': 2, 'Joey Auclair': 7, 'Edgar Rivas': 6 };

// Every manager's finishing status for a season — settled placings for the eliminated, a
// live "current round" status for anyone still alive. Returns the shape described in
// js/playoffStatus.js (entries / standings / currentRound / complete / podium), or null when
// the league has no managers.
//
// Scoring invariant: managers come from the commissioner page (getManagers) and nowhere else;
// who qualified and who advanced come from the canonical bracket helpers (getSeeding /
// getSFParticipants / getFinalsParticipants), and every round total comes from roundBreakdown
// — i.e. the date-windowed, period-scoped rosters, never the sticky `manager` field on a stat
// row. That's the same source the Playoff Bracket card reads, so the Hall of Fame can't
// disagree with the bracket about a result. Nothing here writes to seasonData.
function hofPlayoffStatuses(sd) {
  if (!sd) return null;
  const managerNames = getManagers()
    .filter((m) => m.active !== false)
    .map((m) => m.name);
  if (managerNames.length === 0) return null;

  const finalized = sd.finalized_rounds || [];
  const seeding = getSeeding(sd);
  const qualifiers = (seeding && seeding.qualifierNames) || [];

  // Pool-play totals order the non-qualifiers. Computed live even when a confirmed seeding
  // snapshot exists — the snapshot fixes WHO qualified, not what anyone scored.
  const ppTotals = {};
  const poolPlay = computePoolPlaySeeding(sd);
  if (poolPlay) Object.values(poolPlay.byManager).forEach((s) => (ppTotals[s.manager] = s.total));

  // Round totals are only needed for rounds already in the books: they order the managers
  // eliminated in that round and decide the Finals / 3rd-place games.
  const rosterLookup = buildRosterLookup(sd);
  const weekKeyToStart = buildWeekKeyToStart(sd);
  const roundTotals = {};
  ['QF', 'SF', 'Finals'].forEach((round) => {
    if (!finalized.includes(round)) return;
    const totals = {};
    qualifiers.forEach((n) => {
      totals[n] = roundBreakdown(sd, n, round, rosterLookup, weekKeyToStart).total;
    });
    roundTotals[round] = totals;
  });

  return computePlayoffStatuses({
    managers: managerNames,
    qualifiers,
    sfParticipants: getSFParticipants(sd),
    finalsParticipants: getFinalsParticipants(sd),
    finalized,
    ppTotals,
    roundTotals,
  });
}

// The season currently in progress, as a Hall of Fame row. Null until pool play is finalized
// (before that nobody has been eliminated and the field is only a projection) and again once
// the Finals are in the books (from then on it's a finished result like any other, and
// getHofAllResults picks it up). It never wins the reigning-champion banner, and it feeds the
// all-time records only through its settled finishes — see hofRecordResults.
function getHofLiveResult() {
  const lastHistoricalYear = Math.max(...WMMC_HISTORICAL_RESULTS.map((r) => Number(r.year)));
  const seasons = getSeasons();
  const years = Object.keys(seasons)
    .filter((y) => Number(y) > lastHistoricalYear && seasons[y] && seasons[y].status === 'active')
    .sort((a, b) => Number(b) - Number(a));

  for (const year of years) {
    const sd = seasons[year];
    const finalized = sd.finalized_rounds || [];
    if (!finalized.includes('PP') || finalized.includes('Finals')) continue;
    const statuses = hofPlayoffStatuses(sd);
    if (statuses && statuses.entries.length) return { year, ...statuses };
  }
  return null;
}

function buildHofRecords(results) {
  const records = {};
  // Collect all unique manager names across all results
  const allNames = new Set();
  results.forEach((r) => {
    if (r.champion) allNames.add(r.champion);
    if (r.runnerUp) allNames.add(r.runnerUp);
    if (r.third) allNames.add(r.third);
    if (r.standings) Object.keys(r.standings).forEach((n) => allNames.add(n));
  });

  // Initialize all known managers with base season count and position buckets
  allNames.forEach((name) => {
    const positionCounts = {};
    for (let i = 1; i <= 12; i++) positionCounts[i] = 0;
    const baseSeasonsForManager =
      WMMC_SEASON_OVERRIDES[name] !== undefined ? WMMC_SEASON_OVERRIDES[name] : WMMC_TOTAL_SEASONS_THROUGH_2025;
    records[name] = {
      wins: 0,
      seconds: 0,
      thirds: 0,
      seasons: baseSeasonsForManager,
      totalFinish: 0,
      finishCount: 0,
      positionCounts,
    };
  });

  // Count additional seasons beyond the historical period (2026+)
  const extraSeasons = results.filter((r) => Number(r.year) > 2025).length;

  // Add extra seasons to all managers
  if (extraSeasons > 0) {
    const postHistoricalNames = new Set();
    results
      .filter((r) => Number(r.year) > 2025)
      .forEach((r) => {
        if (r.champion) postHistoricalNames.add(r.champion);
        if (r.runnerUp) postHistoricalNames.add(r.runnerUp);
        if (r.third) postHistoricalNames.add(r.third);
        if (r.standings) Object.keys(r.standings).forEach((n) => postHistoricalNames.add(n));
      });
    postHistoricalNames.forEach((name) => {
      if (records[name]) records[name].seasons = WMMC_TOTAL_SEASONS_THROUGH_2025 + extraSeasons;
    });
  }

  // Tally placement finishes and accumulate avg finish data
  results.forEach((r) => {
    if (r.champion && records[r.champion]) records[r.champion].wins++;
    if (r.runnerUp && records[r.runnerUp]) records[r.runnerUp].seconds++;
    if (r.third && records[r.third]) records[r.third].thirds++;
    if (r.standings) {
      Object.entries(r.standings).forEach(([name, pos]) => {
        if (records[name]) {
          records[name].totalFinish += pos;
          records[name].finishCount++;
          if (records[name].positionCounts[pos] !== undefined) records[name].positionCounts[pos]++;
        }
      });
    }
  });

  // Compute avgFinish — only from seasons with full standings data provided directly
  // (2024/2025 historical + any 2026+ season finalized within the app)
  Object.values(records).forEach((r) => {
    r.avgFinish = r.finishCount > 0 ? r.totalFinish / r.finishCount : null;
  });

  return records;
}

function hofSortedManagers(records, col, asc) {
  return Object.entries(records)
    .map(([name, r]) => ({
      name,
      ...r,
    }))
    .sort((a, b) => {
      if (col === 'avgFinish') {
        if (a.avgFinish === null && b.avgFinish === null) return 0;
        if (a.avgFinish === null) return 1;
        if (b.avgFinish === null) return -1;
        const diff = asc ? a.avgFinish - b.avgFinish : b.avgFinish - a.avgFinish;
        return diff !== 0 ? diff : b.wins - a.wins;
      }
      // Support sorting by position columns (pos1..pos12)
      const posMatch = col.match(/^pos(\d+)$/);
      if (posMatch) {
        const p = parseInt(posMatch[1]);
        const aVal = a.positionCounts ? a.positionCounts[p] || 0 : 0;
        const bVal = b.positionCounts ? b.positionCounts[p] || 0 : 0;
        const diff = asc ? aVal - bVal : bVal - aVal;
        return diff !== 0 ? diff : b.wins - a.wins;
      }
      const diff = asc ? a[col] - b[col] : b[col] - a[col];
      if (diff !== 0) return diff;
      // Tiebreaker: for wins column use avgFinish (lower is better), else fall back to wins desc
      if (col === 'wins') {
        if (a.avgFinish === null && b.avgFinish === null) return 0;
        if (a.avgFinish === null) return 1;
        if (b.avgFinish === null) return -1;
        return a.avgFinish - b.avgFinish;
      }
      return b.wins - a.wins;
    });
}

function hofManagerRowHtml(m, i, hasAvg) {
  const trophies = m.wins > 0 ? ' ' + '&#127942;'.repeat(Math.min(m.wins, 5)) : '';
  let posCells = '';
  for (let p = 1; p <= 12; p++) {
    const count = m.positionCounts ? m.positionCounts[p] || 0 : 0;
    posCells += `<td class="num">${count || '—'}</td>`;
  }
  const avgCell = hasAvg ? `<td class="num">${m.avgFinish !== null ? m.avgFinish.toFixed(1) : '—'}</td>` : '';
  return `<tr>
    <td class="rank">${i + 1}</td>
    <td><strong>${esc(m.name)}</strong>${trophies}</td>
    ${posCells}
    ${avgCell}
  </tr>`;
}

function getHofAllResults() {
  // Use hardcoded historical data as the source of truth through 2025.
  // Only auto-compute results for seasons AFTER the last historical year.
  const lastHistoricalYear = Math.max(...WMMC_HISTORICAL_RESULTS.map((r) => Number(r.year)));
  const seasons = getSeasons();
  const computed = [];

  Object.entries(seasons)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([year, sd]) => {
      // Skip any year covered by historical data (prevents double-counting)
      if (Number(year) <= lastHistoricalYear) return;

      let result = null;

      // Legacy completed season (bracket format)
      if (sd.status === 'completed' && sd.data && sd.data.bracket) {
        const b = sd.data.bracket;
        let champion = null,
          runnerUp = null,
          third = null;
        if (b.finals && b.finals.winner) {
          champion = b.finals.winner;
          runnerUp = b.finals.manager1 === champion ? b.finals.manager2 : b.finals.manager1;
        }
        if (b.third_place && b.third_place.winner) third = b.third_place.winner;
        if (champion) result = { year, champion, runnerUp, third };
      }

      // Finalized Finals — resolve the full 1-12 standings from the bracket
      if (!result && sd.finalized_rounds && sd.finalized_rounds.includes('Finals')) {
        const full = hofPlayoffStatuses(sd);
        if (full && full.complete) {
          const { champion, runnerUp, third, standings } = full;
          result = { year, champion, runnerUp, third, standings };
        }
      }

      if (result) computed.push(result);
    });

  return [...WMMC_HISTORICAL_RESULTS, ...computed].sort((a, b) => Number(a.year) - Number(b.year));
}

// The two <tr>s for the season in progress: a summary line for the year, plus the expandable
// per-manager standing. Eliminated managers hold the round they went out in and their settled
// placing; managers still alive carry the round they're playing right now, marked live and
// ranked by seed above the field they've already knocked out. Returns '' when no season is
// mid-playoffs.
function hofLiveSeasonRowsHtml(live) {
  if (!live) return '';

  const key = `live-${live.year}`;
  const roundLabel = BRACKET_STAGE_LABELS[live.currentRound] || live.currentRound || '';
  const aliveCount = live.entries.filter((e) => e.live).length;
  const summary =
    live.currentRound === 'PP'
      ? 'Pool play under way — the playoff field isn’t set yet'
      : `${roundLabel} under way · ${aliveCount} manager${aliveCount === 1 ? '' : 's'} still alive`;

  const rows = live.entries
    .map((e) => {
      const posLabel = e.position != null ? e.position : '—';
      const seedBadge = e.seed ? `<span class="hof-seed" title="#${e.seed} seed">${e.seed}</span>` : '';
      const status = e.live
        ? `<span class="hof-status-live">${esc(e.status)}</span>`
        : `<span class="hof-status-out">${esc(e.status)}</span>`;
      return `<tr><td class="num">${posLabel}</td><td>${seedBadge}${esc(e.name)}</td><td>${status}</td></tr>`;
    })
    .join('');

  return `<tr class="hof-live-row">
      <td><strong>${esc(live.year)}</strong> <span class="hof-live-badge">In Progress</span></td>
      <td colspan="3" class="text-muted">${summary}</td>
      <td><button class="btn btn-sm btn-secondary" onclick="toggleHofStandings('${key}')" id="hof-toggle-btn-${key}">Full &#9650;</button></td>
    </tr>
    <tr id="hof-standings-${key}"><td colspan="5" style="padding:0 0.5rem 0.5rem;">
      <table class="data-table" style="margin:0;">
        <thead><tr><th>#</th><th>Manager</th><th>Round</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </td></tr>`;
}

// What the All-Time Records table counts. Finished seasons contribute everything; a season in
// progress contributes only the finishes that are already SETTLED — a manager's placing is
// locked the moment the round that knocked them out ends (seeded within that round by its
// score: the lowest pool-play total is 12th, the lowest quarterfinal score 8th, and so on), so
// it counts from then on. Managers still alive contribute nothing until their round finishes,
// and the in-progress season awards no title until the Finals are in the books.
function hofRecordResults(allResults, live) {
  if (!live || !live.standings || Object.keys(live.standings).length === 0) return allResults;
  return [...allResults, { year: live.year, standings: live.standings, inProgress: true }];
}

// ============================================================
// HYPOTHETICAL ZONE ("What If")
// ============================================================
// A sandbox for the question managers keep asking: what would the standings look like if the
// scoring were different? It is READ-ONLY BY CONSTRUCTION — no endpoint here writes, no season
// object is mutated, nothing reaches db.json. The scenario lives in localStorage and in the URL.
//
// Reality is the baseline, never a recomputation of it: the engine takes the roster slots the REAL
// scoring path produced (managerWeekSubtotal, which owns the roster-window invariant) together
// with the score it credited, and derives only the DELTA a different point table would cause. So
// the "Real" column is always the live scoreboard's own number, and an unmodified scenario shows
// zero movement by construction. See js/hypothetical.js for the full rationale.

const HYPO_STORAGE_KEY = 'wmmc_hypothetical';
let HYPO_SCENARIO = { scoring: { batting: {}, pitching: {} }, rosters: {} };
let HYPO_SNAPSHOT = null;
let HYPO_SNAPSHOT_KEY = null;
let HYPO_RECOMPUTE_TIMER = null;
let HYPO_EXPANDED = null; // manager whose player-level breakdown is open
let HYPO_LAB_MANAGER = null; // Roster Lab: manager being edited
let HYPO_LAB_ROUND = null; // Roster Lab: period being edited
let HYPO_SWAP_OPEN = null; // Roster Lab: { player, type } whose swap picker is open

function loadHypoScenario() {
  // The URL wins over stored state so a shared link always opens the scenario it encodes.
  const fromHash = /[#&]whatif=([^&]+)/.exec(window.location.hash || '');
  if (fromHash) {
    try {
      const parsed = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(fromHash[1])))));
      if (parsed && typeof parsed === 'object') {
        HYPO_SCENARIO = {
          scoring: { batting: {}, pitching: {}, ...(parsed.scoring || {}) },
          rosters: parsed.rosters || {},
        };
        return;
      }
    } catch (_) {
      // A corrupt link falls through to stored state rather than blanking the tab.
    }
  }
  try {
    const raw = localStorage.getItem(HYPO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      HYPO_SCENARIO = {
        scoring: { batting: {}, pitching: {}, ...((parsed || {}).scoring || {}) },
        rosters: (parsed || {}).rosters || {},
      };
    }
  } catch (_) {
    /* a scenario is disposable — never let bad stored state break the tab */
  }
}

function saveHypoScenario() {
  try {
    localStorage.setItem(HYPO_STORAGE_KEY, JSON.stringify(HYPO_SCENARIO));
  } catch (_) {
    /* quota — the scenario just won't survive a reload */
  }
}

// Resolve every manager's roster slots for the season through the REAL eligibility path, so the
// sandbox inherits the roster-window invariant instead of restating it. Cached per season +
// data revision: this is the same work the scoreboard does, and it must not re-run per keystroke.
function buildHypoSnapshot(year) {
  const seasons = getSeasons();
  const sd = seasons[year];
  if (!sd) return null;

  const managers = getManagers().filter((m) => m.active !== false);
  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const scheduleDates = sd.schedule_dates || [];
  const daily = getDailyStatsCached(year);
  const slots = [];

  SEASON_SCHEDULE.forEach((schedWeek, idx) => {
    const weekKey = `${schedWeek.round}|${schedWeek.week}`;
    const wd = scheduleDates[idx] || null;
    managers.forEach((m) => {
      const mgrWeekDates = ((sd.roster_dates || {})[m.name] || {})[weekKey] || {};
      [
        ['batting', batting, 'batter', 'batters'],
        ['pitching', pitching, 'pitcher', 'pitchers'],
      ].forEach(([type, rows, playerKey, listKey]) => {
        const detail = [];
        managerWeekSubtotal(sd, m.name, schedWeek, idx, rows, playerKey, listKey, detail);
        detail.forEach((d) => {
          // This manager's own slice of the week — what splits a mid-week handover so each side
          // is re-scored over only the days they actually held the player.
          const win = managerWeekWindow(mgrWeekDates[d.player], {
            weekStart: wd && wd.start,
            weekEnd: wd && wd.end,
          });
          slots.push({
            manager: m.name,
            round: schedWeek.round,
            week: schedWeek.week,
            weekIdx: idx,
            player: d.player,
            type,
            realScore: d.score,
            addDate: (win && win.start) || null,
            dropDate: (win && win.end) || null,
          });
        });
      });
    });
  });

  // Pools drive the hypothetical playoff picture. Only pooled managers are seeded, exactly as in
  // the real bracket.
  const pools = {};
  managers.forEach((m) => {
    if (m.pool) pools[m.name] = m.pool;
  });

  return buildSnapshot({
    slots,
    dailyBatting: (daily && daily.batting) || [],
    dailyPitching: (daily && daily.pitching) || [],
    weeklyBatting: batting,
    weeklyPitching: pitching,
    scheduleDates,
    playerDates: sd.player_dates || {},
    managers: managers.map((m) => m.name),
    schedule: SEASON_SCHEDULE,
    pools,
  });
}

function hypoSnapshot(year) {
  const sd = getSeasons()[year];
  const key = `${year}|${(sd && sd._rev) || ''}|${getDailyStatsCached(year) ? 'daily' : 'weekly'}`;
  if (!HYPO_SNAPSHOT || HYPO_SNAPSHOT_KEY !== key) {
    HYPO_SNAPSHOT = buildHypoSnapshot(year);
    HYPO_SNAPSHOT_KEY = key;
  }
  return HYPO_SNAPSHOT;
}

function hypoScoringValue(side, key) {
  const override = (HYPO_SCENARIO.scoring || {})[side] || {};
  if (key in override) return override[key];
  return SCORING[side][key] != null ? SCORING[side][key] : 0;
}

function setHypoScoringValue(side, key, raw) {
  if (!HYPO_SCENARIO.scoring[side]) HYPO_SCENARIO.scoring[side] = {};
  const real = SCORING[side][key] != null ? SCORING[side][key] : 0;
  const num = Number(raw);
  const value = Number.isFinite(num) ? num : 0;
  // Storing only genuine differences keeps "is this the identity scenario?" honest — a slider
  // dragged back to its real value leaves no trace.
  if (value === real) delete HYPO_SCENARIO.scoring[side][key];
  else HYPO_SCENARIO.scoring[side][key] = value;
  saveHypoScenario();
  scheduleHypoRecompute();
}

function resetHypoScenario() {
  HYPO_SCENARIO = { scoring: { batting: {}, pitching: {} }, rosters: {} };
  saveHypoScenario();
  renderWhatIf();
}

// Recompute is debounced so dragging through values doesn't rescore on every keystroke, and only
// the output halves are repainted — repainting the inputs would steal focus mid-edit.
function scheduleHypoRecompute() {
  clearTimeout(HYPO_RECOMPUTE_TIMER);
  HYPO_RECOMPUTE_TIMER = setTimeout(() => {
    renderHypoOutputs();
    renderHypoBadges();
  }, 120);
}

// Score once, paint both output panels from the same result. The Roster Lab and the standings must
// never disagree, which they could if each ran its own pass.
function renderHypoOutputs() {
  const snapshot = hypoSnapshot(SELECTED_SEASON);
  const result = snapshot ? scoreScenario(snapshot, HYPO_SCENARIO) : null;
  renderRosterLab(snapshot, result);
  renderPlayerExplorer();
  renderHypoResults(result);
}

function hypoShareLink() {
  const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(HYPO_SCENARIO)))));
  return `${window.location.origin}${window.location.pathname}#whatif=${encoded}`;
}

function copyHypoLink() {
  const link = hypoShareLink();
  const done = (ok) => {
    const el = document.getElementById('whatif-share-status');
    if (el) el.textContent = ok ? 'Link copied' : link;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(
      () => done(true),
      () => done(false)
    );
  } else {
    done(false);
  }
}

const hypoDelta = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const hypoDeltaClass = (n) => (n > 0 ? 'hypo-up' : n < 0 ? 'hypo-down' : 'hypo-flat');

function hypoScoringInputs(side, keys, unscored) {
  const cell = (key, isNew) => {
    const value = hypoScoringValue(side, key);
    const real = SCORING[side][key] != null ? SCORING[side][key] : 0;
    const changed = value !== real;
    return `<tr class="${changed ? 'hypo-row-changed' : ''}">
      <td class="hypo-stat-key">${esc(key)}${isNew ? ' <span class="hypo-new-tag">unscored</span>' : ''}</td>
      <td><input type="number" step="0.05" class="hypo-input" data-side="${side}" data-key="${esc(key)}" value="${value}" aria-label="${esc(key)} points"></td>
      <td class="hypo-badge-cell" id="hypo-badge-${side}-${esc(key)}">${changed ? `<span class="hypo-badge">${fmt(real)} &rarr; ${fmt(value)}</span>` : ''}</td>
    </tr>`;
  };
  return `<table class="data-table compact-table hypo-scoring-table">
    <thead><tr><th>Stat</th><th>Points</th><th></th></tr></thead>
    <tbody>
      ${keys.map((k) => cell(k, false)).join('')}
      ${unscored.map((k) => cell(k, true)).join('')}
    </tbody>
  </table>`;
}

function renderHypoBadges() {
  for (const side of ['batting', 'pitching']) {
    for (const key of Object.keys(SCORING[side])) {
      const el = document.getElementById(`hypo-badge-${side}-${key}`);
      if (!el) continue;
      const value = hypoScoringValue(side, key);
      const real = SCORING[side][key];
      el.innerHTML = value !== real ? `<span class="hypo-badge">${fmt(real)} &rarr; ${fmt(value)}</span>` : '';
      const row = el.closest('tr');
      if (row) row.classList.toggle('hypo-row-changed', value !== real);
    }
  }
  const keys = scoringKeys();
  for (const [side, list] of [
    ['batting', keys.batting.unscored],
    ['pitching', keys.pitching.unscored],
  ]) {
    for (const key of list) {
      const el = document.getElementById(`hypo-badge-${side}-${key}`);
      if (!el) continue;
      const value = hypoScoringValue(side, key);
      el.innerHTML = value !== 0 ? `<span class="hypo-badge">0 &rarr; ${fmt(value)}</span>` : '';
      const row = el.closest('tr');
      if (row) row.classList.toggle('hypo-row-changed', value !== 0);
    }
  }
}

// Which slice of the season the standings table is ranking. A season total conflates competitions
// that are actually separate: pool play decides seeding, and each playoff round is its own contest.
// "Who would have scored the most in the quarterfinals" is not answerable from a season column, so
// the table scopes to one round at a time.
//
// Pool Play (PP1 + PP2 combined) is offered as its own scope because that combined total is exactly
// what the seeding rule ranks on — see js/seeding.js.
let HYPO_STANDINGS_SCOPE = 'season';

const HYPO_SCOPES = [
  { key: 'season', label: 'Season', rounds: null },
  { key: 'PP', label: 'Pool Play', rounds: ['PP1', 'PP2'] },
  { key: 'PP1', label: 'Pool Play 1', rounds: ['PP1'] },
  { key: 'PP2', label: 'Pool Play 2', rounds: ['PP2'] },
  { key: 'QF', label: 'Quarterfinals', rounds: ['QF'] },
  { key: 'SF', label: 'Semifinals', rounds: ['SF'] },
  { key: 'Finals', label: 'Finals', rounds: ['Finals'] },
];

// Totals for one manager within a scope, summed from the per-period figures the engine returns.
function hypoScopeTotals(entry, rounds) {
  if (!rounds) return { real: entry.real, hypothetical: entry.hypothetical, delta: entry.delta };
  let real = 0;
  let hypothetical = 0;
  for (const p of entry.periods) {
    if (!rounds.includes(p.round)) continue;
    real += p.real;
    hypothetical += p.hypothetical;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { real: r2(real), hypothetical: r2(hypothetical), delta: r2(hypothetical - real) };
}

// The standings for a scope, re-ranked within it. A manager eliminated before this round has no
// rows for it and would rank last on zero points, which reads as "he scored nothing" rather than
// "he wasn't there" — so managers with no data in the scope are dropped instead.
function hypoScopedStandings(result, rounds) {
  const rows = result.standings
    .map((s) => {
      const played = !rounds || s.periods.some((p) => rounds.includes(p.round));
      return { manager: s.manager, played, ...hypoScopeTotals(s, rounds) };
    })
    .filter((r) => r.played);

  rows.sort((a, b) => b.hypothetical - a.hypothetical || a.manager.localeCompare(b.manager));
  const realOrder = [...rows].sort((a, b) => b.real - a.real || a.manager.localeCompare(b.manager));
  const realRank = new Map(realOrder.map((r, i) => [r.manager, i + 1]));
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.realRank = realRank.get(r.manager);
    r.rankDelta = r.realRank - r.rank;
  });
  return rows;
}

// Only offer a scope the season actually has rows for — an unplayed Finals tab is a dead end.
function hypoAvailableScopes(result) {
  const rounds = new Set();
  for (const s of result.standings) for (const p of s.periods) if (p.real || p.hypothetical) rounds.add(p.round);
  return HYPO_SCOPES.filter((sc) => !sc.rounds || sc.rounds.some((r) => rounds.has(r)));
}

// ---- Playoff Picture ----
// Pool play is scored by POOL, and the field is filled by a specific rule. Showing a flat list of
// totals hides both. This renders the pools the way the league actually decides them — each pool's
// PP1 and PP2 leaders, then the wildcards that fill the rest — followed by the bracket those seeds
// produce under the scenario.

// Badges for a manager's standing in the field, marked GAINED or LOST against what really
// happened. A hypothetical that flips a pool crown or a wild card is the headline result — showing
// only the end state would leave the reader to diff two tables in their head.
function hypoSeedBadges(entry, seeding, realSeeding) {
  const real = realSeeding && realSeeding.byManager[entry.manager];
  const badges = [];
  const mark = (label, now, was, winStyle) => {
    if (!now && !was) return;
    const cls = winStyle ? 'hypo-badge hypo-badge-win' : 'hypo-badge';
    if (now && !was) badges.push(`<span class="${cls} hypo-badge-gain">${label} &uarr; gained</span>`);
    else if (!now && was) badges.push(`<span class="hypo-badge hypo-badge-lost">${label} &darr; lost</span>`);
    else badges.push(`<span class="${cls}">${label}</span>`);
  };
  mark('PP1 winner', entry.isPP1Leader, !!(real && real.isPP1Leader), true);
  mark('PP2 winner', entry.isPP2Leader, !!(real && real.isPP2Leader), true);
  const gainedCrown =
    (entry.isPP1Leader && !(real && real.isPP1Leader)) || (entry.isPP2Leader && !(real && real.isPP2Leader));
  const wcNow = seeding.wildcardSet.has(entry.manager);
  const wcWas = !!(realSeeding && realSeeding.wildcardSet.has(entry.manager));
  // A wild card given up because this manager won their pool is not a loss worth flagging.
  if (!(wcWas && !wcNow && gainedCrown)) mark('Wild card', wcNow, wcWas, false);
  return badges.join(' ');
}

function renderHypoPools(seeding, realSeeding) {
  const pools = {};
  for (const entry of Object.values(seeding.byManager)) {
    (pools[entry.pool] = pools[entry.pool] || []).push(entry);
  }
  const seedOf = new Map(seeding.qualifierNames.map((n, i) => [n, i + 1]));
  const realSeedOf = new Map((realSeeding ? realSeeding.qualifierNames : []).map((n, i) => [n, i + 1]));

  const flips = [];
  if (realSeeding) {
    for (const entry of Object.values(seeding.byManager)) {
      const real = realSeeding.byManager[entry.manager];
      if (!real) continue;
      if (entry.isPP1Leader && !real.isPP1Leader) flips.push(`${entry.manager} takes Pool Play 1`);
      if (!entry.isPP1Leader && real.isPP1Leader) flips.push(`${entry.manager} loses Pool Play 1`);
      if (entry.isPP2Leader && !real.isPP2Leader) flips.push(`${entry.manager} takes Pool Play 2`);
      if (!entry.isPP2Leader && real.isPP2Leader) flips.push(`${entry.manager} loses Pool Play 2`);
      const wcNow = seeding.wildcardSet.has(entry.manager);
      const wcWas = realSeeding.wildcardSet.has(entry.manager);
      // Losing a wild card BY WINNING THE POOL is a promotion, not a demotion — reporting it as a
      // loss reads exactly backwards. Only mention the wild card when the pool crown didn't change.
      const gainedCrown = (entry.isPP1Leader && !real.isPP1Leader) || (entry.isPP2Leader && !real.isPP2Leader);
      const lostCrown = (!entry.isPP1Leader && real.isPP1Leader) || (!entry.isPP2Leader && real.isPP2Leader);
      if (wcNow && !wcWas && !lostCrown) flips.push(`${entry.manager} takes a wild card`);
      if (!wcNow && wcWas && !gainedCrown) flips.push(`${entry.manager} loses a wild card`);
    }
  }

  let html = flips.length
    ? `<p class="hypo-playoffs hypo-playoffs-changed">Pool play changes hands &mdash; ${flips
        .map(esc)
        .join(' &middot; ')}</p>`
    : '';

  html += `<p class="upload-hint hypo-rule">
    <strong>How the field is decided.</strong> Each pool crowns a <strong>Pool Play 1 winner</strong>
    (most PP1 points in that pool) and a <strong>Pool Play 2 winner</strong> (most PP2 points) — one
    manager can be both. Every pool winner is seeded above every non-winner. The remaining spots go
    to the highest-scoring managers who won neither period, as <strong>wild cards</strong>. Within
    each group the order is total points, then periods won, then batting, pitching, PP2, PP1.
  </p>`;

  for (const pool of Object.keys(pools).sort()) {
    const rows = pools[pool].slice().sort((a, b) => b.total - a.total);
    html += `<h4 class="hypo-pool-title">${esc(formatPool(pool))}</h4>
      <div class="table-wrapper"><table class="data-table compact-table hypo-pool-table">
        <thead><tr><th>Manager</th><th>PP1</th><th>PP2</th><th>Total</th><th>Seed</th><th></th></tr></thead>
        <tbody>`;
    for (const e of rows) {
      const seed = seedOf.get(e.manager);
      const realSeed = realSeedOf.get(e.manager);
      const moved = seed !== realSeed;
      html += `<tr class="${seed ? 'hypo-qualified' : ''}">
        <td>${esc(e.manager)}</td>
        <td class="hypo-num${e.isPP1Leader ? ' hypo-strong' : ''}">${fmt(e.pp1)}</td>
        <td class="hypo-num${e.isPP2Leader ? ' hypo-strong' : ''}">${fmt(e.pp2)}</td>
        <td class="hypo-num hypo-strong">${fmt(e.total)}</td>
        <td class="hypo-num">${
          seed
            ? `${seed}${moved ? ` <span class="${realSeed ? 'hypo-up' : 'hypo-up'}">(was ${realSeed || 'out'})</span>` : ''}`
            : `<span class="hypo-flat">&ndash;${realSeed ? ` <span class="hypo-down">(was ${realSeed})</span>` : ''}</span>`
        }</td>
        <td>${hypoSeedBadges(e, seeding, realSeeding)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  return html;
}

function hypoMatchupSide(side, round, carriedBy) {
  if (!side) return '<span class="hypo-flat">TBD</span>';
  const score = side.score == null ? '<span class="hypo-flat">no roster</span>' : `<strong>${fmt(side.score)}</strong>`;
  const carried = carriedBy.get(`${side.name}\u0000${round}`);
  const tag = carried
    ? ` <span class="hypo-new-tag" title="This manager never played this round. Their last real roster (${esc(
        ROUND_LABELS[carried] || carried
      )}) is assumed — change it in the Roster Lab.">${esc(roundShortLabel(carried))} roster</span>`
    : '';
  return `<span class="hypo-seed-chip">${side.seed}</span> ${esc(side.name)} &middot; ${score}${tag}`;
}

function renderHypoBracket(bracket, carried, unplayedRounds) {
  if (!bracket) return '<p class="upload-hint">Not enough managers are seeded to build a bracket.</p>';
  const carriedBy = new Map((carried || []).map((c) => [`${c.manager}\u0000${c.round}`, c.fromRound]));

  let html = '';
  for (const round of bracket.rounds) {
    html += `<h4 class="hypo-pool-title">${esc(round.label)}</h4><div class="hypo-matchups">`;
    for (const m of round.matchups) {
      const winner = m.winner ? m.winner.name : null;
      html += `<div class="hypo-matchup${m.undecided ? ' hypo-matchup-open' : ''}">
        <div class="hypo-matchup-label">${esc(m.label)}</div>
        <div class="hypo-matchup-side${winner && m.a && winner === m.a.name ? ' hypo-matchup-winner' : ''}">${hypoMatchupSide(
          m.a,
          round.round,
          carriedBy
        )}</div>
        <div class="hypo-matchup-side${winner && m.b && winner === m.b.name ? ' hypo-matchup-winner' : ''}">${hypoMatchupSide(
          m.b,
          round.round,
          carriedBy
        )}</div>
      </div>`;
    }
    html += '</div>';
  }

  if (bracket.champion) {
    html += `<p class="hypo-playoffs hypo-playoffs-changed">Champion under this scenario: <strong>${esc(
      bracket.champion
    )}</strong>${bracket.thirdPlace ? ` &middot; 3rd place: ${esc(bracket.thirdPlace)}` : ''}</p>`;
  }

  if (carriedBy.size) {
    html += `<p class="upload-hint hypo-rule">A manager promoted into a round they never played is
      assumed to have run back their last real roster, priced against that round's actual stats.
      Those sides are tagged with the round the roster came from. It is an assumption, not a record
      &mdash; change it in the Roster Lab and the bracket follows.</p>`;
  }

  if (bracket.missing.length) {
    // Two different reasons a side can't be scored, and conflating them would be misleading: the
    // ROUND hasn't been played by anyone yet, or this manager has no roster history to carry.
    const unplayed = new Set(unplayedRounds || []);
    const byRound = {};
    for (const m of bracket.missing) (byRound[m.round] = byRound[m.round] || []).push(m.manager);

    const notYet = Object.keys(byRound).filter((r) => unplayed.has(r));
    const noRoster = Object.entries(byRound).filter(([r]) => !unplayed.has(r));

    if (notYet.length) {
      html += `<p class="hypo-warning">The bracket stops at the ${notYet
        .map((r) => esc(ROUND_LABELS[r] || r))
        .join(' and ')} — nobody has played ${
        notYet.length > 1 ? 'those rounds' : 'that round'
      } yet, so there are no stats to score it with under any scenario.</p>`;
    }
    if (noRoster.length) {
      const parts = noRoster.map(
        ([round, names]) => `${[...new Set(names)].map(esc).join(', ')} in the ${esc(ROUND_LABELS[round] || round)}`
      );
      html += `<p class="hypo-warning">No roster to score: ${parts.join(
        '; '
      )}. They have no earlier roster to carry forward either — add one in the Roster Lab above and the bracket will carry on.</p>`;
    }
  }

  return html;
}

function renderHypoResults(result) {
  const container = document.getElementById('whatif-results');
  if (!container) return;

  if (!result) {
    container.innerHTML = '<p class="upload-hint">No season data loaded yet.</p>';
    return;
  }

  const changes = scoringDiff(HYPO_SCENARIO.scoring);
  const rosterCount = rosterOverrides(HYPO_SCENARIO).length;

  // Resolve the round scope first: the headline counts movement within the table being shown, not
  // across the season, or it would contradict the rows underneath it.
  const scopes = hypoAvailableScopes(result);
  if (!scopes.some((sc) => sc.key === HYPO_STANDINGS_SCOPE)) HYPO_STANDINGS_SCOPE = 'season';
  const scope = scopes.find((sc) => sc.key === HYPO_STANDINGS_SCOPE) || scopes[0];
  const rows = hypoScopedStandings(result, scope.rounds);

  let html = '';

  if (result.identity) {
    html += `<p class="upload-hint">These are the real standings. Change a point value or a roster above to see what would have happened.</p>`;
  } else {
    const moved = rows.filter((s) => s.rankDelta !== 0).length;
    const bits = [];
    if (changes.length) bits.push(`${changes.length} scoring change${changes.length === 1 ? '' : 's'}`);
    if (rosterCount) bits.push(`${rosterCount} roster change${rosterCount === 1 ? '' : 's'}`);
    bits.push(
      moved
        ? `${moved} manager${moved === 1 ? '' : 's'} change position in the ${esc(scope.label.toLowerCase())}`
        : `nobody changes position in the ${esc(scope.label.toLowerCase())}`
    );
    html += `<p class="upload-hint">${bits.join(' &middot; ')}</p>`;
  }

  // An approximate slot is one scored from unclipped weekly totals for a player who was added or
  // dropped mid-week. Saying so is the point: a sandbox that hides its error bars is worse than
  // one that has none.
  if (!result.fidelity.exact) {
    html += `<p class="hypo-warning">Estimated for ${result.fidelity.approximateSlots} mid-week roster slot${
      result.fidelity.approximateSlots === 1 ? '' : 's'
    } — daily stats are still loading, so those players are scored on their full week.</p>`;
  }

  // Round scope selector. Same chip pattern as the Roster Lab's round tabs, so the two panels read
  // as one tool.
  html += `<div class="hypo-round-tabs hypo-scope-tabs">
    ${scopes
      .map(
        (sc) =>
          `<button class="hypo-round-tab${sc.key === scope.key ? ' active' : ''}" data-scope="${esc(sc.key)}">${esc(
            sc.label
          )}</button>`
      )
      .join('')}
  </div>`;

  html += `<p class="upload-hint">${
    scope.rounds
      ? `Ranked on ${esc(scope.label)} points only &mdash; ${rows.length} manager${rows.length === 1 ? '' : 's'} played this round.`
      : 'Ranked on the full season.'
  }</p>`;

  // A round showing no movement is ambiguous, so say which kind of nothing it is: the stat never
  // happened here, or it is recorded in the weekly totals but absent from the per-game rows the
  // scorer reads. The second is a data gap, and reporting it as "no change" would be misleading.
  if (!result.identity && rows.length && rows.every((r) => r.delta === 0)) {
    const snapshot = hypoSnapshot(SELECTED_SEASON);
    const scopeRounds = scope.rounds || [...new Set(SEASON_SCHEDULE.map((w) => w.round))];
    const coverage = snapshot ? scenarioStatCoverage(snapshot, HYPO_SCENARIO, scopeRounds) : [];
    const notes = [];
    for (const change of coverage) {
      const scored = change.rounds.reduce((a, r) => a + r.scored, 0);
      const recorded = change.rounds.reduce((a, r) => a + r.recorded, 0);
      if (scored !== 0) continue;
      notes.push(
        recorded > 0
          ? `<strong>${esc(change.key)}</strong> is recorded in the weekly totals for ${esc(
              scope.label
            )} (${fmt(recorded)}) but is missing from the per-game rows this tool scores, so changing its value cannot move this round. That is a gap in the stored daily data, not a scoring result.`
          : `No <strong>${esc(change.key)}</strong> was recorded in ${esc(
              scope.label
            )} at all, so changing its value has nothing to act on here.`
      );
    }
    if (notes.length) html += `<p class="hypo-warning">${notes.join(' ')}</p>`;
  }

  html += `<div class="table-wrapper"><table class="data-table hypo-standings">
    <thead><tr><th></th><th>Manager</th><th>Real</th><th>What If</th><th>&Delta;</th><th>Move</th></tr></thead>
    <tbody>`;
  rows.forEach((s) => {
    const move = s.rankDelta > 0 ? `&uarr; ${s.rankDelta}` : s.rankDelta < 0 ? `&darr; ${-s.rankDelta}` : '&ndash;';
    html += `<tr class="hypo-standings-row" data-manager="${esc(s.manager)}">
      <td class="hypo-rank">${s.rank}</td>
      <td>${esc(s.manager)}</td>
      <td class="hypo-num">${fmt(s.real)}</td>
      <td class="hypo-num hypo-strong">${fmt(s.hypothetical)}</td>
      <td class="hypo-num ${hypoDeltaClass(s.delta)}">${hypoDelta(s.delta)}</td>
      <td class="hypo-num ${hypoDeltaClass(s.rankDelta)}">${move}</td>
    </tr>`;
    if (HYPO_EXPANDED === s.manager) {
      // Scope the player breakdown to the same rounds, so the rows sum to the total on this line.
      const movers = result.playerRounds
        .filter((p) => p.manager === s.manager && (!scope.rounds || scope.rounds.includes(p.round)))
        .reduce((acc, p) => {
          const key = `${p.player}|${p.type}`;
          const e = acc.get(key) || { player: p.player, real: 0, hypothetical: 0, delta: 0 };
          e.real += p.real;
          e.hypothetical += p.hypothetical;
          e.delta += p.delta;
          acc.set(key, e);
          return acc;
        }, new Map());
      const list = [...movers.values()]
        .filter((p) => Math.round(p.delta * 100) !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 15);
      const detailRows = list.length
        ? list
            .map(
              (p) =>
                `<tr><td>${displayPlayer(p.player, getSeasons()[SELECTED_SEASON])}</td><td class="hypo-num">${fmt(
                  Math.round(p.real * 100) / 100
                )}</td><td class="hypo-num">${fmt(Math.round(p.hypothetical * 100) / 100)}</td><td class="hypo-num ${hypoDeltaClass(
                  p.delta
                )}">${hypoDelta(Math.round(p.delta * 100) / 100)}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="upload-hint">No player on this roster is affected by these changes.</td></tr>';
      html += `<tr class="hypo-detail-row"><td colspan="6">
        <table class="data-table compact-table">
          <thead><tr><th>Player</th><th>Real</th><th>What If</th><th>&Delta;</th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </td></tr>`;
    }
  });
  html += '</tbody></table></div>';

  container.innerHTML = html;

  container.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      HYPO_STANDINGS_SCOPE = btn.dataset.scope;
      renderHypoResults(result);
    });
  });

  container.querySelectorAll('.hypo-standings-row').forEach((row) => {
    row.addEventListener('click', () => {
      const name = row.dataset.manager;
      HYPO_EXPANDED = HYPO_EXPANDED === name ? null : name;
      renderHypoResults(result);
    });
  });

  renderHypoPlayoffs(result);
}

function renderHypoPlayoffs(result) {
  const el = document.getElementById('whatif-playoffs');
  if (!el) return;
  const po = result && result.playoffs;
  if (!po || !po.seeding) {
    el.innerHTML = '<p class="upload-hint">Pools are not configured for this season, so there is no field to seed.</p>';
    return;
  }

  let html = '';
  if (po.changed) {
    const parts = [];
    if (po.in.length) parts.push(`<strong>In:</strong> ${po.in.map(esc).join(', ')}`);
    if (po.out.length) parts.push(`<strong>Out:</strong> ${po.out.map(esc).join(', ')}`);
    if (!parts.length) parts.push('the same managers qualify, but the seeding order changes');
    html += `<p class="hypo-playoffs hypo-playoffs-changed">Playoff picture changes &mdash; ${parts.join(' &middot; ')}</p>`;
  } else if (!result.identity) {
    html += `<p class="hypo-playoffs">The same managers qualify, in the same order.</p>`;
  }

  html += renderHypoPools(po.seeding, po.realSeeding);
  html += renderHypoBracket(po.bracket, po.carried, po.unplayedRounds);
  el.innerHTML = html;
}

// ---- Roster Lab ----
// Start a player who was really on the bench. Start a player who was never rostered at all. Build
// a roster for a round you never reached. Every one of those is the same operation: replace a
// manager's roster for one PERIOD, then rescore.
//
// The view is deliberately two columns — what they ACTUALLY had beside what the scenario gives
// them — because the whole value of a hypothetical is the comparison. A single mutated list would
// show the answer while hiding what it is an answer to.

const HYPO_ROUNDS = () => [...new Set(SEASON_SCHEDULE.map((s) => s.round))];

function hypoLabManager() {
  const managers = getManagers().filter((m) => m.active !== false);
  if (!managers.length) return null;
  if (HYPO_LAB_MANAGER && managers.some((m) => m.name === HYPO_LAB_MANAGER)) return HYPO_LAB_MANAGER;
  // Default to the signed-in manager — the person asking "what if" is usually asking about
  // themselves.
  const me = managers.find((m) => (m.email || '').toLowerCase() === (LOGGED_IN_EMAIL || '').toLowerCase());
  return me ? me.name : managers[0].name;
}

function hypoLabRound() {
  const rounds = HYPO_ROUNDS();
  return HYPO_LAB_ROUND && rounds.includes(HYPO_LAB_ROUND) ? HYPO_LAB_ROUND : rounds[0];
}

// The roster the scenario is currently using for this period: the override if one exists,
// otherwise the real roster (which is what the lab opens with).
function hypoEffectiveRoster(snapshot, manager, round) {
  const override = ((HYPO_SCENARIO.rosters || {})[manager] || {})[round];
  if (override) return { batters: (override.batters || []).slice(), pitchers: (override.pitchers || []).slice() };
  const real = realRosterForRound(snapshot, manager, round);
  if (real.batters.length || real.pitchers.length) return real;
  // A round they never played: start from the last roster they actually fielded, the same default
  // the bracket uses, so the lab opens on something to edit rather than an empty column.
  const carried = lastKnownRoster(snapshot, manager, round);
  return carried ? { batters: carried.batters.slice(), pitchers: carried.pitchers.slice() } : real;
}

function setHypoRoster(manager, round, roster) {
  if (!HYPO_SCENARIO.rosters) HYPO_SCENARIO.rosters = {};
  if (!HYPO_SCENARIO.rosters[manager]) HYPO_SCENARIO.rosters[manager] = {};
  HYPO_SCENARIO.rosters[manager][round] = { batters: roster.batters.slice(), pitchers: roster.pitchers.slice() };
  saveHypoScenario();
  renderHypoOutputs();
}

function clearHypoRoster(manager, round) {
  if (((HYPO_SCENARIO.rosters || {})[manager] || {})[round]) {
    delete HYPO_SCENARIO.rosters[manager][round];
    if (Object.keys(HYPO_SCENARIO.rosters[manager]).length === 0) delete HYPO_SCENARIO.rosters[manager];
    saveHypoScenario();
  }
  renderHypoOutputs();
}

function hypoRemovePlayer(manager, round, type, player) {
  const snapshot = hypoSnapshot(SELECTED_SEASON);
  const roster = hypoEffectiveRoster(snapshot, manager, round);
  const key = type === 'batting' ? 'batters' : 'pitchers';
  roster[key] = roster[key].filter((p) => p !== player);
  setHypoRoster(manager, round, roster);
}

// Replace one player with another IN PLACE, so the swapped-in name keeps the outgoing player's
// position in the list and the two columns still line up row for row.
function hypoSwapPlayer(manager, round, type, outPlayer, inPlayer) {
  if (!inPlayer || inPlayer === outPlayer) {
    HYPO_SWAP_OPEN = null;
    renderHypoOutputs();
    return;
  }
  const snapshot = hypoSnapshot(SELECTED_SEASON);
  const roster = hypoEffectiveRoster(snapshot, manager, round);
  const key = type === 'batting' ? 'batters' : 'pitchers';
  const idx = roster[key].indexOf(outPlayer);
  const already = roster[key].indexOf(inPlayer);
  if (already !== -1) roster[key].splice(already, 1);
  if (idx === -1) roster[key].push(inPlayer);
  else roster[key][idx > already && already !== -1 ? idx - 1 : idx] = inPlayer;
  HYPO_SWAP_OPEN = null;
  setHypoRoster(manager, round, roster);
}

function hypoAddPlayer(manager, round, type, player) {
  if (!player) return;
  const snapshot = hypoSnapshot(SELECTED_SEASON);
  const roster = hypoEffectiveRoster(snapshot, manager, round);
  const key = type === 'batting' ? 'batters' : 'pitchers';
  if (!roster[key].includes(player)) roster[key].push(player);
  setHypoRoster(manager, round, roster);
}

// How many suggestions any player search offers at once. The pools are seeded from MLB's whole
// active catalog, so an unranked list is ~1,300 names of mostly-irrelevant players — and rendering
// that many <option> nodes is what makes a native datalist crawl. Showing the top scorers instead
// covers essentially everyone a manager would consider, and typing still searches the full league.
const HYPO_SUGGESTION_LIMIT = 50;

// Candidates for a roster add box, ranked by points within the round being edited. Scoping to the
// round matters: a player with no stat line that period would silently score zero and look broken.
function hypoPlayerOptions(snapshot, round, type, query) {
  return playerSuggestions(snapshot, { type, round, query, limit: HYPO_SUGGESTION_LIMIT });
}

// Replace a datalist's options in place. Called on every keystroke, so it keeps the node count at
// the suggestion limit rather than growing a list the browser then has to filter itself.
function hypoFillDatalist(id, suggestions) {
  const list = document.getElementById(id);
  if (!list) return;
  list.innerHTML = suggestions.map((p) => `<option value="${esc(p.name)}">${fmt(p.points)} pts</option>`).join('');
}

function hypoRosterColumn(title, subtitle, rows, opts) {
  const { removable = false, manager, round, empty } = opts || {};
  const sd = getSeasons()[SELECTED_SEASON];
  const section = (label, type) => {
    const list = rows.filter((r) => r.type === type);
    if (!list.length) return `<div class="hypo-roster-section"><h4>${label}</h4><p class="upload-hint">None</p></div>`;
    return `<div class="hypo-roster-section"><h4>${label}</h4>
      <table class="data-table compact-table hypo-roster-table"><tbody>
      ${list
        .map((r) => {
          // In the editable column the NAME is the control: click it to swap this player out for
          // someone else. A bare × only ever removed, which is not what a manager is actually
          // asking — "who would I have started instead" is a replacement, not a deletion.
          const nameCell = removable
            ? `<button class="hypo-swap-name" data-swap="${esc(r.player)}" data-type="${type}" title="Click to swap this player out">${displayPlayer(
                r.player,
                sd
              )}</button>`
            : displayPlayer(r.player, sd);
          const open = HYPO_SWAP_OPEN && HYPO_SWAP_OPEN.player === r.player && HYPO_SWAP_OPEN.type === type;
          return `<tr class="${r.muted ? 'hypo-roster-muted' : ''}${r.added ? ' hypo-roster-added' : ''}${
            open ? ' hypo-roster-swapping' : ''
          }">
            <td>${nameCell}${r.tag ? ` <span class="hypo-new-tag">${r.tag}</span>` : ''}</td>
            <td class="hypo-num">${fmt(r.points)}</td>
            ${
              removable
                ? `<td class="hypo-roster-action"><button class="hypo-x" data-remove="${esc(r.player)}" data-type="${type}" title="Remove from this hypothetical roster">&times;</button></td>`
                : ''
            }
          </tr>${
            open
              ? `<tr class="hypo-swap-row"><td colspan="3">
                  <label>Swap <strong>${esc(r.player)}</strong> for
                    <input type="text" id="hypo-swap-input" list="hypo-list-${type}" placeholder="Top scorers — or type a name">
                  </label>
                  <button class="btn btn-sm btn-secondary" id="hypo-swap-cancel">Cancel</button>
                </td></tr>`
              : ''
          }`;
        })
        .join('')}
      </tbody></table></div>`;
  };
  const total = rows.reduce((s, r) => s + r.points, 0);
  const body = rows.length
    ? section('Batters', 'batting') + section('Pitchers', 'pitching')
    : `<p class="upload-hint hypo-roster-empty">${empty || 'Nothing here.'}</p>`;
  return `<div class="hypo-roster-col" data-manager="${esc(manager || '')}" data-round="${esc(round || '')}">
    <div class="hypo-roster-head"><h3>${title}</h3><span class="upload-hint">${subtitle}</span></div>
    ${body}
    <div class="hypo-roster-total"><span>Total</span><strong>${fmt(Math.round(total * 100) / 100)}</strong></div>
  </div>`;
}

function renderRosterLab(snapshot, result) {
  const container = document.getElementById('whatif-roster-lab');
  if (!container) return;
  if (!snapshot || !result) {
    container.innerHTML = '<p class="upload-hint">No season data loaded yet.</p>';
    return;
  }

  const managers = getManagers().filter((m) => m.active !== false);
  const manager = hypoLabManager();
  const round = hypoLabRound();
  if (!manager) {
    container.innerHTML = '<p class="upload-hint">No managers configured.</p>';
    return;
  }

  const played = roundsPlayed(snapshot, manager);
  const realRoster = realRosterForRound(snapshot, manager, round);
  const effective = hypoEffectiveRoster(snapshot, manager, round);
  const hasOverride = !!((HYPO_SCENARIO.rosters || {})[manager] || {})[round];
  const didPlay = played.has(round);

  const prRows = result.playerRounds.filter((p) => p.manager === manager && p.round === round);
  const prFor = (player, type) => prRows.find((p) => p.player === player && p.type === type);

  // LEFT — what actually happened. Never edited, never reordered.
  const actualRows = [];
  for (const [type, list] of [
    ['batting', realRoster.batters],
    ['pitching', realRoster.pitchers],
  ]) {
    for (const player of list) {
      const pr = prFor(player, type);
      const dropped = !(type === 'batting' ? effective.batters : effective.pitchers).includes(player);
      actualRows.push({
        player,
        type,
        points: pr ? pr.real : 0,
        muted: dropped,
        tag: dropped ? 'benched' : '',
      });
    }
  }

  // RIGHT — what the scenario gives them, in the roster's own order. A swap writes the replacement
  // into the outgoing player's slot (see hypoSwapPlayer), so the two columns still line up row for
  // row and you can read a substitution straight across. Sorting added players to the bottom would
  // undo exactly that.
  const hypoRows = [];
  for (const [type, list] of [
    ['batting', effective.batters],
    ['pitching', effective.pitchers],
  ]) {
    for (const player of list) {
      const pr = prFor(player, type);
      const isNew = !(type === 'batting' ? realRoster.batters : realRoster.pitchers).includes(player);
      hypoRows.push({
        player,
        type,
        points: pr ? pr.hypothetical : 0,
        added: isNew,
        tag: isNew ? 'added' : '',
      });
    }
  }

  const actualTotal = actualRows.reduce((s, r) => s + r.points, 0);
  const hypoTotal = hypoRows.reduce((s, r) => s + r.points, 0);
  const diff = Math.round((hypoTotal - actualTotal) * 100) / 100;

  let html = `<div class="hypo-lab-controls">
    <label>Manager
      <select id="hypo-lab-manager">
        ${managers.map((m) => `<option value="${esc(m.name)}"${m.name === manager ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select>
    </label>
    <div class="hypo-round-tabs">
      ${HYPO_ROUNDS()
        .map(
          (r) =>
            `<button class="hypo-round-tab${r === round ? ' active' : ''}${played.has(r) ? '' : ' hypo-round-unplayed'}" data-round="${esc(r)}">${esc(
              ROUND_LABELS[r] || r
            )}${played.has(r) ? '' : ' *'}</button>`
        )
        .join('')}
    </div>
    ${hasOverride ? `<button class="btn btn-sm btn-secondary" id="hypo-lab-reset-round">Restore real roster</button>` : ''}
  </div>`;

  if (!didPlay) {
    html += `<p class="hypo-warning">${esc(manager)} never reached the ${esc(
      ROUND_LABELS[round] || round
    )} — there is no real roster to compare against. Add players below to score the round they didn't play. Those points are a projection of what those players did that period, not a record of anything that happened.</p>`;
  }

  html += `<div class="hypo-roster-grid">
    ${hypoRosterColumn('Actually rostered', didPlay ? 'What really happened' : 'Did not play this round', actualRows, {
      manager,
      round,
      empty: `${esc(manager)} had no roster for this round.`,
    })}
    ${hypoRosterColumn(
      'What If roster',
      hasOverride ? 'Your changes' : didPlay ? 'Same roster as real — edit to compare' : 'Nothing entered yet',
      hypoRows,
      {
        removable: true,
        manager,
        round,
        empty: 'Empty roster — nobody scores.',
      }
    )}
  </div>`;

  html += `<div class="hypo-roster-summary ${hypoDeltaClass(diff)}">
    ${didPlay ? `Real ${fmt(Math.round(actualTotal * 100) / 100)} &rarr; ` : ''}What If ${fmt(
      Math.round(hypoTotal * 100) / 100
    )} <strong>(${hypoDelta(diff)})</strong> for the ${esc(ROUND_LABELS[round] || round)}
  </div>`;

  const batOptions = hypoPlayerOptions(snapshot, round, 'batting');
  const pitOptions = hypoPlayerOptions(snapshot, round, 'pitching');
  const opt = (p) => `<option value="${esc(p.name)}">${fmt(p.points)} pts</option>`;

  if (!batOptions.length && !pitOptions.length) {
    // No stat rows exist for this round at all — usually a playoff round that hasn't been played
    // yet. There is nothing to score anyone against, so offering a search box would be a dead end.
    html += `<p class="upload-hint hypo-no-candidates">No stats have been recorded for the ${esc(
      ROUND_LABELS[round] || round
    )} yet, so there is nothing to score a roster against for this round.</p>`;
  } else {
    html += `<div class="hypo-add-row">
      <label>Add a batter <input type="text" id="hypo-add-batting" list="hypo-list-batting" placeholder="Top scorers — or type a name"></label>
      <datalist id="hypo-list-batting">${batOptions.map(opt).join('')}</datalist>
      <label>Add a pitcher <input type="text" id="hypo-add-pitching" list="hypo-list-pitching" placeholder="Top scorers — or type a name"></label>
      <datalist id="hypo-list-pitching">${pitOptions.map(opt).join('')}</datalist>
    </div>
    <p class="upload-hint">Showing this round's top ${HYPO_SUGGESTION_LIMIT} scorers. Start typing to search every player.</p>`;
  }

  container.innerHTML = html;

  const mgrSelect = document.getElementById('hypo-lab-manager');
  if (mgrSelect) {
    mgrSelect.addEventListener('change', () => {
      HYPO_LAB_MANAGER = mgrSelect.value;
      HYPO_SWAP_OPEN = null;
      renderHypoOutputs();
    });
  }
  container.querySelectorAll('.hypo-round-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      HYPO_LAB_ROUND = btn.dataset.round;
      HYPO_SWAP_OPEN = null;
      renderHypoOutputs();
    });
  });
  const resetRound = document.getElementById('hypo-lab-reset-round');
  if (resetRound) resetRound.addEventListener('click', () => clearHypoRoster(manager, round));
  container.querySelectorAll('.hypo-x').forEach((btn) => {
    btn.addEventListener('click', () => {
      HYPO_SWAP_OPEN = null;
      hypoRemovePlayer(manager, round, btn.dataset.type, btn.dataset.remove);
    });
  });

  container.querySelectorAll('.hypo-swap-name').forEach((btn) => {
    btn.addEventListener('click', () => {
      const same =
        HYPO_SWAP_OPEN && HYPO_SWAP_OPEN.player === btn.dataset.swap && HYPO_SWAP_OPEN.type === btn.dataset.type;
      HYPO_SWAP_OPEN = same ? null : { player: btn.dataset.swap, type: btn.dataset.type };
      renderHypoOutputs();
      const input = document.getElementById('hypo-swap-input');
      if (input) input.focus();
    });
  });

  const swapInput = document.getElementById('hypo-swap-input');
  if (swapInput && HYPO_SWAP_OPEN) {
    const { player: outPlayer, type: swapType } = HYPO_SWAP_OPEN;
    const commitSwap = () => hypoSwapPlayer(manager, round, swapType, outPlayer, swapInput.value.trim());
    swapInput.addEventListener('change', commitSwap);
    swapInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commitSwap();
      if (ev.key === 'Escape') {
        HYPO_SWAP_OPEN = null;
        renderHypoOutputs();
      }
    });
    swapInput.addEventListener('input', () => {
      hypoFillDatalist(`hypo-list-${swapType}`, hypoPlayerOptions(snapshot, round, swapType, swapInput.value));
    });
  }
  const swapCancel = document.getElementById('hypo-swap-cancel');
  if (swapCancel) {
    swapCancel.addEventListener('click', () => {
      HYPO_SWAP_OPEN = null;
      renderHypoOutputs();
    });
  }
  for (const type of ['batting', 'pitching']) {
    const input = document.getElementById(`hypo-add-${type}`);
    if (!input) continue;
    const commit = () => {
      const name = input.value.trim();
      if (!name) return;
      input.value = '';
      hypoAddPlayer(manager, round, type, name);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
    });
    // Re-rank the offered names against what has been typed so far, keeping the option list at the
    // cap instead of handing the browser the whole league to filter.
    input.addEventListener('input', () => {
      hypoFillDatalist(`hypo-list-${type}`, hypoPlayerOptions(snapshot, round, type, input.value));
    });
  }
}

// ---- Player Explorer ----
// Look up ANY player with recorded stats — rostered or not — and see what he actually did, what he
// was worth under the real rubric, and what he'd be worth under the current scenario. This is the
// panel that answers "what if I'd started him" without building a scenario at all.

let HYPO_EXPLORER_TYPE = 'batting';
let HYPO_EXPLORER_PLAYER = null;

// The stat columns worth showing per side. Deliberately a subset — a game log is for reading, and
// every stored field would make it a spreadsheet.
const EXPLORER_COLUMNS = {
  batting: [
    ['1b', '1B'],
    ['2b', '2B'],
    ['3b', '3B'],
    ['hr', 'HR'],
    ['r', 'R'],
    ['rbi', 'RBI'],
    ['sb', 'SB'],
    ['bb', 'BB'],
  ],
  pitching: [
    ['ip', 'IP'],
    ['h', 'H'],
    ['er', 'ER'],
    ['bb', 'BB'],
    ['k', 'K'],
    ['w', 'W'],
    ['qs', 'QS'],
  ],
};

function renderPlayerExplorer() {
  const container = document.getElementById('whatif-explorer');
  if (!container) return;
  // Always read the CURRENT snapshot rather than one captured when a handler was bound: the daily
  // stats land asynchronously, and a stale closure would keep showing "no game log" after they do.
  const snapshot = hypoSnapshot(SELECTED_SEASON);
  if (!snapshot) {
    container.innerHTML = '<p class="upload-hint">No season data loaded yet.</p>';
    return;
  }

  const type = HYPO_EXPLORER_TYPE;
  const sd = getSeasons()[SELECTED_SEASON];
  const suggestions = playerSuggestions(snapshot, { type, limit: HYPO_SUGGESTION_LIMIT });

  let html = `<div class="hypo-lab-controls">
    <div class="hypo-round-tabs">
      <button class="hypo-round-tab${type === 'batting' ? ' active' : ''}" data-xtype="batting">Batters</button>
      <button class="hypo-round-tab${type === 'pitching' ? ' active' : ''}" data-xtype="pitching">Pitchers</button>
    </div>
    <label>Player
      <input type="text" id="hypo-explorer-search" list="hypo-explorer-list" placeholder="Search any player…" value="${esc(
        HYPO_EXPLORER_PLAYER || ''
      )}">
    </label>
    <datalist id="hypo-explorer-list">${suggestions
      .map((p) => `<option value="${esc(p.name)}">${fmt(p.points)} pts</option>`)
      .join('')}</datalist>
  </div>
  <p class="upload-hint hypo-suggest-note">Showing the season's top ${HYPO_SUGGESTION_LIMIT} ${
    type === 'batting' ? 'batters' : 'pitchers'
  } by points. Start typing to search every player who recorded a stat.</p>`;

  if (!HYPO_EXPLORER_PLAYER) {
    // No extra prompt here — the card intro and the suggestion note above already say it, and on a
    // phone three stacked paragraphs push the search box off the screen.
    container.innerHTML = html;
    wireExplorerControls(container, snapshot);
    return;
  }

  const info = explainPlayer(snapshot, HYPO_EXPLORER_PLAYER, type, HYPO_SCENARIO);

  if (!info.rounds.length) {
    html += `<p class="hypo-warning">No ${type === 'batting' ? 'batting' : 'pitching'} stats recorded for “${esc(
      HYPO_EXPLORER_PLAYER
    )}” this season.${
      playerTypes(snapshot, HYPO_EXPLORER_PLAYER).length
        ? ' Try the other tab — he has stats on the other side of the ball.'
        : ''
    }</p>`;
    container.innerHTML = html;
    wireExplorerControls(container, snapshot);
    return;
  }

  const owners = info.owners.length
    ? info.owners
        .map((o) => `${esc(o.manager)} <span class="upload-hint">(${o.rounds.map(roundShortLabel).join(', ')})</span>`)
        .join(' &middot; ')
    : '<span class="upload-hint">Never rostered by anyone — a free agent all season.</span>';

  html += `<div class="hypo-explorer-head">
    <div>
      <h3>${displayPlayer(info.player, sd)}</h3>
      <div class="hypo-explorer-owners">Rostered by: ${owners}</div>
    </div>
    <div class="hypo-explorer-totals">
      <div><span>Worth (real)</span><strong>${fmt(info.total.real)}</strong></div>
      <div><span>Worth (What If)</span><strong>${fmt(info.total.hypothetical)}</strong></div>
      <div class="${hypoDeltaClass(info.total.delta)}"><span>&Delta;</span><strong>${hypoDelta(info.total.delta)}</strong></div>
    </div>
  </div>`;

  // "Worth" is what his own stat line is worth; "Credited" is what a manager was actually given for
  // him. They differ whenever he was held for only part of a period — keeping the two apart is what
  // stops this table from implying a free agent scored for somebody.
  const labMgr = hypoLabManager();
  html += `<div class="table-wrapper"><table class="data-table compact-table hypo-explorer-table">
    <thead><tr><th>Round</th><th>Wks</th><th>Worth (real)</th><th>Worth (What If)</th><th>&Delta;</th><th>Credited</th><th></th></tr></thead>
    <tbody>`;
  for (const r of info.rounds) {
    html += `<tr>
      <td>${esc(ROUND_LABELS[r.round] || r.round)}</td>
      <td class="hypo-num">${r.weeks}</td>
      <td class="hypo-num">${fmt(r.real)}</td>
      <td class="hypo-num hypo-strong">${fmt(r.hypothetical)}</td>
      <td class="hypo-num ${hypoDeltaClass(r.delta)}">${hypoDelta(r.delta)}</td>
      <td class="hypo-num">${r.credited ? fmt(r.credited) : '&ndash;'}</td>
      <td><button class="btn btn-sm btn-secondary hypo-try" data-round="${esc(r.round)}">Try in ${esc(
        roundShortLabel(r.round)
      )}</button></td>
    </tr>`;
  }
  html += `</tbody></table></div>
    <p class="upload-hint">“Worth” is what this player's own stat line is worth. “Credited” is what a manager was actually given for him — lower when he was only rostered for part of the period. <strong>Try in…</strong> puts him on ${esc(
      labMgr || 'the selected manager'
    )}'s Roster Lab roster for that round.</p>`;

  if (info.hasGameLog) {
    const cols = EXPLORER_COLUMNS[type];
    html += `<h4 class="hypo-log-title">Game log</h4>
      <div class="table-wrapper"><table class="data-table compact-table hypo-explorer-table">
      <thead><tr><th>Date</th><th>Week</th>${cols
        .map(([, label]) => `<th class="hypo-num">${label}</th>`)
        .join('')}<th class="hypo-num">Real</th><th class="hypo-num">What If</th></tr></thead><tbody>`;
    for (const g of info.log) {
      html += `<tr>
        <td>${esc(g.date)}</td>
        <td>${esc(weekLabel(g.round, g.week))}</td>
        ${cols.map(([key]) => `<td class="hypo-num">${g.stats[key] ? fmtDec(g.stats[key]) : '&ndash;'}</td>`).join('')}
        <td class="hypo-num">${fmt(g.real)}</td>
        <td class="hypo-num ${hypoDeltaClass(g.delta)}">${fmt(g.hypothetical)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  } else {
    html += `<p class="upload-hint">Per-game log loads with the daily stats — one moment.</p>`;
  }

  container.innerHTML = html;
  wireExplorerControls(container, snapshot);
}

function wireExplorerControls(container, snapshot) {
  container.querySelectorAll('[data-xtype]').forEach((btn) => {
    btn.addEventListener('click', () => {
      HYPO_EXPLORER_TYPE = btn.dataset.xtype;
      // A name only valid on the other side of the ball would render as "no stats" — clear it
      // unless this player genuinely has rows for the newly selected type.
      if (HYPO_EXPLORER_PLAYER && !playerTypes(snapshot, HYPO_EXPLORER_PLAYER).includes(HYPO_EXPLORER_TYPE)) {
        HYPO_EXPLORER_PLAYER = null;
      }
      renderPlayerExplorer();
    });
  });

  const search = document.getElementById('hypo-explorer-search');
  if (search) {
    const commit = () => {
      const name = search.value.trim();
      HYPO_EXPLORER_PLAYER = name || null;
      // A name typed for the wrong tab is a common miss — switch sides automatically when the
      // player only exists on the other one.
      if (name) {
        const types = playerTypes(snapshot, name);
        if (types.length && !types.includes(HYPO_EXPLORER_TYPE)) HYPO_EXPLORER_TYPE = types[0];
      }
      renderPlayerExplorer();
    };
    search.addEventListener('change', commit);
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
    });
    // Re-rank against the typed text without re-rendering the panel — the datalist stays capped,
    // and a partially typed name never has to be matched against the whole league in the DOM.
    search.addEventListener('input', () => {
      hypoFillDatalist(
        'hypo-explorer-list',
        playerSuggestions(snapshot, { type: HYPO_EXPLORER_TYPE, query: search.value, limit: HYPO_SUGGESTION_LIMIT })
      );
    });
  }

  container.querySelectorAll('.hypo-try').forEach((btn) => {
    btn.addEventListener('click', () => {
      const manager = hypoLabManager();
      if (!manager || !HYPO_EXPLORER_PLAYER) return;
      HYPO_LAB_ROUND = btn.dataset.round;
      hypoAddPlayer(manager, btn.dataset.round, HYPO_EXPLORER_TYPE, HYPO_EXPLORER_PLAYER);
    });
  });
}

function renderWhatIf() {
  const container = document.getElementById('whatif-content');
  if (!container) return;

  const keys = scoringKeys();

  container.innerHTML = `
    <div class="hypo-banner">
      <strong>Hypothetical Zone</strong>
      <span>Nothing here touches league data. Change the numbers, see what would have happened.</span>
    </div>

    <div class="card hypo-card">
      <div class="hypo-toolbar">
        <h2>Scoring Lab</h2>
        <div class="hypo-actions">
          <button class="btn btn-secondary" id="hypo-reset">Reset to reality</button>
          <button class="btn btn-secondary" id="hypo-share">Copy share link</button>
          <span class="upload-hint" id="whatif-share-status"></span>
        </div>
      </div>
      <p class="upload-hint">
        Change what any stat is worth and the standings below rescore instantly. The three batting
        stats and one pitching stat marked <em>unscored</em> are recorded in our data but worth
        nothing today &mdash; set a value to see what would happen if they counted.
      </p>
      <div class="hypo-scoring-grid">
        <div>
          <h3>Batting</h3>
          ${hypoScoringInputs('batting', keys.batting.scored, keys.batting.unscored)}
        </div>
        <div>
          <h3>Pitching</h3>
          ${hypoScoringInputs('pitching', keys.pitching.scored, keys.pitching.unscored)}
        </div>
      </div>
    </div>

    <div class="card hypo-card">
      <div class="hypo-toolbar">
        <h2>Roster Lab</h2>
      </div>
      <p class="upload-hint">
        Swap who you started for a whole period and see it against what you actually had. Rounds
        marked <strong>*</strong> are ones that manager never reached &mdash; you can still enter a
        roster there to see what it would have scored.
      </p>
      <div id="whatif-roster-lab"></div>
    </div>

    <div class="card hypo-card">
      <div class="hypo-toolbar">
        <h2>Player Explorer</h2>
      </div>
      <p class="upload-hint">
        Look up anyone who recorded a stat this season &mdash; they don't have to have been on
        anyone's roster. See what they were worth, what they'd be worth under your scoring, and who
        actually had them.
      </p>
      <div id="whatif-explorer"></div>
    </div>

    <div class="card hypo-card">
      <h2>What If Standings</h2>
      <div id="whatif-results"></div>
    </div>

    <div class="card hypo-card">
      <h2>Playoff Picture</h2>
      <p class="upload-hint">
        How pool play would shake out under this scenario &mdash; by pool, with the period winners
        and wild cards &mdash; and the bracket those seeds produce.
      </p>
      <div id="whatif-playoffs"></div>
    </div>
  `;

  container.querySelectorAll('.hypo-input').forEach((input) => {
    input.addEventListener('input', () => setHypoScoringValue(input.dataset.side, input.dataset.key, input.value));
  });
  const resetBtn = document.getElementById('hypo-reset');
  if (resetBtn) resetBtn.addEventListener('click', resetHypoScenario);
  const shareBtn = document.getElementById('hypo-share');
  if (shareBtn) shareBtn.addEventListener('click', copyHypoLink);

  renderHypoOutputs();

  // Daily rows make mid-week roster slots exact rather than estimated. They are fetched on demand
  // and cached (the Trends tab uses the same cache), so the tab paints immediately on weekly rows
  // and sharpens once they land.
  ensureDailyStats(SELECTED_SEASON, () => {
    HYPO_SNAPSHOT_KEY = null;
    renderHypoOutputs();
  });
}

function renderHallOfFame() {
  const container = document.getElementById('hall-of-fame-content');
  if (!container) return;

  const allResults = getHofAllResults();
  const live = getHofLiveResult();
  const recordResults = hofRecordResults(allResults, live);
  const records = buildHofRecords(recordResults);
  const hasAvg = recordResults.some((r) => r.standings);
  const sorted = hofSortedManagers(records, 'wins', false);
  const lastResult = allResults[allResults.length - 1];

  let html = '';

  // Reigning Champion banner — styled like the Scoreboard banner, centred
  if (lastResult) {
    html += `<div class="champion-banner" style="margin-bottom:1rem;">
      <div class="banner-main" style="justify-content:center;">
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <div style="font-size:2.5rem;line-height:1;">&#127942;</div>
          <div class="banner-center">
            <div class="banner-champ-label">Reigning Champion</div>
            <div class="banner-champ-name">${lastResult.champion}</div>
            <div class="banner-champ-year">${lastResult.year} WMMC Champion</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  // Season-by-season results table with expandable full standings
  html += '<div class="card"><h2>Season Results</h2>';
  html += '<div class="table-wrapper"><table class="data-table">';
  html +=
    '<thead><tr><th>Year</th><th>&#127942; Champion</th><th>2nd Place</th><th>3rd Place</th><th></th></tr></thead><tbody>';

  // The season in progress sits on top, expanded by default — it's the row people are
  // actually watching. Its placings fill in round by round as managers are eliminated.
  html += hofLiveSeasonRowsHtml(live);

  [...allResults].reverse().forEach((r) => {
    const hasStandings = !!r.standings;
    const toggleBtn = `<button class="btn btn-sm btn-secondary" onclick="toggleHofStandings('${r.year}')" id="hof-toggle-btn-${r.year}">${hasStandings ? 'Full &#9660;' : ''}</button>`;
    html += `<tr>
      <td><strong>${r.year}</strong></td>
      <td><strong style="color:var(--accent);">&#127942; ${r.champion || '—'}</strong></td>
      <td>${r.runnerUp || '—'}</td>
      <td>${r.third || '—'}</td>
      <td>${hasStandings ? toggleBtn : ''}</td>
    </tr>`;
    if (hasStandings) {
      const rows = Object.entries(r.standings)
        .sort((a, b) => a[1] - b[1])
        .map(([name, pos]) => {
          const posLabel = pos === 1 ? '&#127942;' : pos <= 3 ? `<strong>${pos}</strong>` : pos;
          return `<tr><td class="num">${posLabel}</td><td>${esc(name)}</td><td>${playoffStatusLabel(statusKeyForPosition(pos))}</td></tr>`;
        })
        .join('');
      html += `<tr id="hof-standings-${r.year}" style="display:none;"><td colspan="5" style="padding:0 0.5rem 0.5rem;">
        <table class="data-table" style="margin:0;">
          <thead><tr><th>#</th><th>Manager</th><th>Round</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </td></tr>`;
    }
  });
  html += '</tbody></table></div></div>';

  // All-time records table — shows all 12 finishing positions
  html += '<div class="card" style="margin-top:1rem;"><h2>All-Time Records</h2>';
  html += `<p class="text-muted" style="font-size:0.85rem;margin-bottom:0.5rem;">Click a column header to sort. Position counts based on seasons with full standings data${live ? ', including the finishes already settled in the season in progress' : ''}.</p>`;
  html += '<div class="table-wrapper"><table class="data-table hof-records-table" id="hof-table"><thead><tr>';
  html += '<th>#</th><th>Manager</th>';
  for (let p = 1; p <= 12; p++) {
    const label = p === 1 ? '&#127942;' : p + positionSuffix(p);
    html += `<th onclick="sortHOF('pos${p}')" style="cursor:pointer;" title="${ordinal(p)} place finishes">${label} &#8597;</th>`;
  }
  if (hasAvg) html += `<th onclick="sortHOF('avgFinish')" style="cursor:pointer;">Avg &#8597;</th>`;
  html += '</tr></thead><tbody id="hof-tbody">';
  sorted.forEach((m, i) => {
    html += hofManagerRowHtml(m, i, hasAvg);
  });
  html += '</tbody></table></div></div>';

  container.innerHTML = html;
  container._hasAvg = hasAvg;
  // Cached so a column re-sort doesn't recompute the whole season's bracket math.
  container._recordResults = recordResults;
}

function positionSuffix(n) {
  if (n === 1) return 'st';
  if (n === 2) return 'nd';
  if (n === 3) return 'rd';
  return 'th';
}
function ordinal(n) {
  return n + positionSuffix(n);
}

window.toggleHofStandings = function (year) {
  const row = document.getElementById('hof-standings-' + year);
  if (!row) return;
  const opening = row.style.display === 'none';
  row.style.display = opening ? '' : 'none';
  const btn = document.getElementById('hof-toggle-btn-' + year);
  if (btn) btn.innerHTML = opening ? 'Full &#9650;' : 'Full &#9660;';
};

let _hofSortCol = 'wins';
let _hofSortAsc = false;
window.sortHOF = function (col) {
  if (_hofSortCol === col) {
    _hofSortAsc = !_hofSortAsc;
  } else {
    _hofSortCol = col;
    _hofSortAsc = col === 'avgFinish';
  } // avgFinish: lower is better, default asc

  const tbody = document.getElementById('hof-tbody');
  if (!tbody) {
    renderHallOfFame();
    return;
  }

  const container = document.getElementById('hall-of-fame-content');
  const hasAvg = container ? container._hasAvg : false;
  const records = buildHofRecords(
    (container && container._recordResults) || hofRecordResults(getHofAllResults(), getHofLiveResult())
  );
  const sorted = hofSortedManagers(records, _hofSortCol, _hofSortAsc);
  tbody.innerHTML = sorted.map((m, i) => hofManagerRowHtml(m, i, hasAvg)).join('');
};

// ============================================================
// Helpers
// ============================================================
// Pure helpers — esc, jsStr, fmt, fmtDec, parseNum, getInitials, fmtDateISO,
// parseCSVLine, findColumn — and shared constants — SCORING, SEASON_SCHEDULE,
// convertIP, calculateBattingScore, calculatePitchingScore — live in js/*.js
// modules and are attached to window by js/index.js before this file runs.

// True if the currently logged-in user is the commissioner. Consolidates
// 13 sites that previously inlined the same getManagers().some(...) predicate.
function isLoggedInCommissioner() {
  if (!LOGGED_IN_EMAIL) return false;
  const email = LOGGED_IN_EMAIL.toLowerCase();
  return getManagers().some((m) => m.email && m.email.toLowerCase() === email && m.commissioner);
}

// Format a pool value as a display label without doubling the word "Pool".
// Manager records assign a bare pool ("1"/"2"/"A"), but some data sources store
// the full label ("Pool 1"); prefixing blindly produced "Pool Pool A". Prefix
// only when the value isn't already a "Pool …" label.
function formatPool(pool) {
  if (pool === null || pool === undefined || pool === '') return '';
  const s = String(pool).trim();
  return /^pool\b/i.test(s) ? s : `Pool ${s}`;
}

function getPool(manager) {
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.pools) return '';
  for (const [pool, members] of Object.entries(DATA.scoreboard.pools)) {
    if (members.includes(manager)) return pool;
  }
  return '';
}

function resetSelect(id, options, labelMap) {
  const select = document.getElementById(id);
  const current = select.value;
  select.innerHTML = `<option value="all">${select.querySelector('option').textContent}</option>`;
  options.forEach((opt) => {
    if (opt) {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = labelMap && labelMap[opt] ? labelMap[opt] : opt;
      select.appendChild(el);
    }
  });
  if ([...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

// Load and start
loadData();
