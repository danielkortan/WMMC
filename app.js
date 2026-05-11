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

// Google Sign-In Client ID — set this to enable Google login. Note: Google
// sign-in users currently can't reach commissioner-only endpoints because the
// server middleware verifies the email/password pair — there's no Google token
// exchange flow.
const GOOGLE_CLIENT_ID = '';

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
  // 401/403 means our cached creds are stale (commissioner role revoked,
  // password changed, etc.). Force re-login.
  if (resp.status === 401) {
    localStorage.removeItem('wmmc_logged_in_email');
    localStorage.removeItem('wmmc_logged_in_password');
    window.location.reload();
  }
  return resp;
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
function getPeriodOpenDate(sd, period) {
  const dates = sd && sd.schedule_dates;
  if (!dates) return null;
  switch (period) {
    case 'pp1':
      return null; // open once pool is ready
    case 'pp2': {
      // Opens on the final Sunday of PP1 (PP1 Week 5 end date)
      const idx = SEASON_SCHEDULE.findIndex((s) => s.round === 'PP1' && s.week === 'Week 5');
      return idx >= 0 && dates[idx] ? new Date(dates[idx].end + 'T00:00:00') : null;
    }
    case 'qf': {
      // Opens Monday after PP2 ends (PP2 Week 5 end + 1 day)
      const idx = SEASON_SCHEDULE.findIndex((s) => s.round === 'PP2' && s.week === 'Week 5');
      if (idx < 0 || !dates[idx]) return null;
      const d = new Date(dates[idx].end + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return d;
    }
    case 'sf': {
      // Opens Monday after QF ends
      const idx = SEASON_SCHEDULE.findIndex((s) => s.round === 'QF' && s.week === 'Week 2');
      if (idx < 0 || !dates[idx]) return null;
      const d = new Date(dates[idx].end + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return d;
    }
    case 'finals': {
      // Opens Monday after SF ends
      const idx = SEASON_SCHEDULE.findIndex((s) => s.round === 'SF' && s.week === 'Week 2');
      if (idx < 0 || !dates[idx]) return null;
      const d = new Date(dates[idx].end + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return d;
    }
    default:
      return null;
  }
}

// Returns a Date for the first MLB game of a period's start date, or null if not configured
function getPeriodFirstGame(sd, period) {
  const val = sd && sd.period_deadlines && sd.period_deadlines[period];
  return val ? new Date(val) : null;
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

// ---- Playoff Qualification Helpers ----

// Returns array of up to 8 QF qualifier names based on PP1+PP2 scores (or null if pools not configured)
function getQFQualifiers(sd) {
  const managers = getManagers().filter((m) => m.active !== false);
  const poolGroups = {};
  managers.forEach((m) => {
    if (m.pool) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });
  if (Object.keys(poolGroups).length === 0) return null;

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const mgrScores = {};
  managers.forEach((m) => {
    mgrScores[m.name] = { pp1: 0, pp2: 0 };
  });
  batting.forEach((b) => {
    if (!mgrScores[b.manager]) return;
    if (b.round === 'PP1') mgrScores[b.manager].pp1 += b.weekly_score || 0;
    if (b.round === 'PP2') mgrScores[b.manager].pp2 += b.weekly_score || 0;
  });
  pitching.forEach((p) => {
    if (!mgrScores[p.manager]) return;
    if (p.round === 'PP1') mgrScores[p.manager].pp1 += p.weekly_score || 0;
    if (p.round === 'PP2') mgrScores[p.manager].pp2 += p.weekly_score || 0;
  });

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();
  for (const members of Object.values(poolGroups)) {
    let bestPP1 = null,
      bPP1 = -Infinity;
    let bestPP2 = null,
      bPP2 = -Infinity;
    members.forEach((n) => {
      const s = mgrScores[n] || { pp1: 0, pp2: 0 };
      if (s.pp1 > bPP1) {
        bestPP1 = n;
        bPP1 = s.pp1;
      }
      if (s.pp2 > bPP2) {
        bestPP2 = n;
        bPP2 = s.pp2;
      }
    });
    if (bestPP1) pp1Leaders.add(bestPP1);
    if (bestPP2) pp2Leaders.add(bestPP2);
  }
  const allLeaders = new Set([...pp1Leaders, ...pp2Leaders]);
  const ppTotals = {};
  managers.forEach((m) => {
    ppTotals[m.name] = (mgrScores[m.name]?.pp1 || 0) + (mgrScores[m.name]?.pp2 || 0);
  });
  const wildcardsNeeded = Math.max(0, 8 - allLeaders.size);
  const wildcards = managers
    .map((m) => m.name)
    .filter((n) => !allLeaders.has(n))
    .sort((a, b) => ppTotals[b] - ppTotals[a])
    .slice(0, wildcardsNeeded);
  const qualifiers = [...[...allLeaders].sort((a, b) => ppTotals[b] - ppTotals[a]), ...wildcards];
  return qualifiers.length > 0 ? qualifiers.slice(0, 8) : null;
}

// Returns array of SF participant names (QF winners), or null if QF not finalized
function getSFParticipants(sd) {
  const qf = getQFQualifiers(sd);
  if (!qf || qf.length < 8) return null;
  if (!(sd.finalized_rounds || []).includes('QF')) return null;
  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  function qfScore(mgr) {
    let t = 0;
    batting.filter((b) => b.manager === mgr && b.round === 'QF').forEach((b) => (t += b.weekly_score || 0));
    pitching.filter((p) => p.manager === mgr && p.round === 'QF').forEach((p) => (t += p.weekly_score || 0));
    return t;
  }
  return [
    [qf[0], qf[7]],
    [qf[3], qf[4]],
    [qf[2], qf[5]],
    [qf[1], qf[6]],
  ].map(([a, b]) => (qfScore(a) >= qfScore(b) ? a : b));
}

// Returns array of Finals participant names (SF winners), or null if SF not finalized
function getFinalsParticipants(sd) {
  const sf = getSFParticipants(sd);
  if (!sf || sf.length < 4) return null;
  if (!(sd.finalized_rounds || []).includes('SF')) return null;
  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  function sfScore(mgr) {
    let t = 0;
    batting.filter((b) => b.manager === mgr && b.round === 'SF').forEach((b) => (t += b.weekly_score || 0));
    pitching.filter((p) => p.manager === mgr && p.round === 'SF').forEach((p) => (t += p.weekly_score || 0));
    return t;
  }
  return [
    [sf[0], sf[1]],
    [sf[2], sf[3]],
  ].map(([a, b]) => (sfScore(a) >= sfScore(b) ? a : b));
}

// Returns true if a manager is qualified for a given period (all managers qualify for pp1/pp2)
function isManagerQualifiedForPeriod(managerName, period, sd) {
  if (period === 'pp1' || period === 'pp2') return true;
  if (period === 'qf') {
    const q = getQFQualifiers(sd);
    return q ? q.includes(managerName) : false;
  }
  if (period === 'sf') {
    const q = getSFParticipants(sd);
    return q ? q.includes(managerName) : false;
  }
  if (period === 'finals') {
    const q = getFinalsParticipants(sd);
    return q ? q.includes(managerName) : false;
  }
  return false;
}

// ---- Period Submission Data Helpers ----

function getPeriodSub(sd, period, manager) {
  if (period === 'pp1') return sd.initial_submissions && sd.initial_submissions[manager];
  return sd.period_submissions && sd.period_submissions[period] && sd.period_submissions[period][manager];
}

function ensurePeriodSub(sd, period, manager) {
  if (period === 'pp1') {
    if (!sd.initial_submissions) sd.initial_submissions = {};
    if (!sd.initial_submissions[manager])
      {sd.initial_submissions[manager] = { batters: [], pitchers: [], status: 'draft' };}
    return sd.initial_submissions[manager];
  }
  if (!sd.period_submissions) sd.period_submissions = {};
  if (!sd.period_submissions[period]) sd.period_submissions[period] = {};
  if (!sd.period_submissions[period][manager])
    {sd.period_submissions[period][manager] = { batters: [], pitchers: [], status: 'draft' };}
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

  const scheduleEntry = SEASON_SCHEDULE[latestIdx];
  const dates = getScheduleDates();
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

  const roundNames = {
    PP1: 'Pool Play 1',
    PP2: 'Pool Play 2',
    QF: 'Quarterfinals',
    SF: 'Semifinals',
    Finals: 'Finals',
  };

  return {
    round: latestRound,
    week: latestWeek,
    label: scheduleEntry.label,
    weekIndex: latestIdx,
    weekNum,
    totalRoundWeeks,
    dateRange,
    roundName: roundNames[latestRound] || latestRound,
    roundStartDate,
    roundEndDate,
  };
}

// ============================================================
// Player display helper — shows "Juan Soto (NYM)" when team data exists
// ============================================================
function displayPlayer(name, sd) {
  if (!name) return '';
  const team = (sd && sd.batters_team && sd.batters_team[name]) || (sd && sd.pitchers_team && sd.pitchers_team[name]);
  if (!team || name.endsWith(`(${team})`)) return esc(name);
  return `${esc(name)} (${esc(team)})`;
}

// Visible badge for pitchers who had 2+ starts in a week — QS can't be auto-calculated,
// commissioner needs to manually score it in the app.
function multiStartTag() {
  return ' <span class="multi-start-tag" title="Multiple starts this week — review and set QS manually">⚠ Multi-Start</span>';
}

// ============================================================
// Data helpers (localStorage cache + server persistence)
// ============================================================
function getSeasons() {
  return JSON.parse(localStorage.getItem('wmmc_seasons') || '{}');
}
function saveSeason(year, data) {
  const seasons = getSeasons();
  seasons[year] = data;
  localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
  // Persist to server in background
  apiFetch('/api/seasons/' + year, {
    method: 'POST',
    body: JSON.stringify(data),
  }).catch(() => {});
}
function getManagers() {
  return JSON.parse(localStorage.getItem('wmmc_managers') || '[]');
}
function saveManagers(managers) {
  localStorage.setItem('wmmc_managers', JSON.stringify(managers));
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
  // ---- Sync from server (shared database) ----
  try {
    const [seasonsResp, managersResp] = await Promise.all([fetch('/api/seasons'), fetch('/api/managers')]);
    if (seasonsResp.ok) {
      const serverSeasons = await seasonsResp.json();
      if (serverSeasons && Object.keys(serverSeasons).length > 0) {
        localStorage.setItem('wmmc_seasons', JSON.stringify(serverSeasons));
      }
    }
    if (managersResp.ok) {
      const serverManagers = await managersResp.json();
      if (serverManagers && serverManagers.length > 0) {
        localStorage.setItem('wmmc_managers', JSON.stringify(serverManagers));
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
      localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
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
    localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
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

  // Check for existing auth session
  const savedAuth = localStorage.getItem('wmmc_logged_in_email');
  if (savedAuth) {
    const mgr = findManagerByEmail(savedAuth);
    if (mgr) {
      LOGGED_IN_EMAIL = savedAuth.toLowerCase();
      enterApp(mgr);
    } else {
      localStorage.removeItem('wmmc_logged_in_email');
    }
  }

  // If not logged in, show login screen
  if (!LOGGED_IN_EMAIL) {
    document.getElementById('login-screen').style.display = 'flex';
  }

  setupLoginHandlers();
  initGoogleSignIn();
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
        if (localStorage.getItem('wmmc_seasons') !== incoming) {
          localStorage.setItem('wmmc_seasons', incoming);
          changed = true;
        }
      }
    }
    if (managersResp.ok) {
      const serverManagers = await managersResp.json();
      if (serverManagers && serverManagers.length > 0) {
        const incoming = JSON.stringify(serverManagers);
        if (localStorage.getItem('wmmc_managers') !== incoming) {
          localStorage.setItem('wmmc_managers', incoming);
          changed = true;
        }
      }
    }
    return changed;
  } catch (e) {
    return false;
  }
}

// ============================================================
// Authentication
// ============================================================
function findManagerByEmail(email) {
  const managers = getManagers();
  return managers.find((m) => m.email && m.email.toLowerCase() === email.toLowerCase());
}

function enterApp(mgr) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('user-bar').style.display = 'flex';
  document.getElementById('user-display-name').textContent = mgr.name;
  setupUserBar();

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

  // Restore the tab the user was on before refreshing
  const savedTab = localStorage.getItem('wmmc_active_tab');
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
  if (savedTab === 'trends') renderTrends();
  if (savedTab === 'hall-of-fame') renderHallOfFame();

  // Poll for changes every 45 seconds so logged-in users always see
  // the latest data without needing a page refresh.
  setInterval(async () => {
    if (!LOGGED_IN_EMAIL) return;
    const changed = await syncFromServer();
    if (changed) init();
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

function handleGoogleCredential(response) {
  const errEl = document.getElementById('google-signin-error');
  try {
    // Decode the JWT payload (base64url)
    const payload = JSON.parse(atob(response.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const email = (payload.email || '').toLowerCase();

    if (!email) {
      errEl.textContent = 'Could not read email from Google account.';
      return;
    }

    const mgr = findManagerByEmail(email);
    if (!mgr) {
      errEl.textContent = 'This Google account is not registered. Contact the commissioner.';
      return;
    }

    errEl.textContent = '';
    LOGGED_IN_EMAIL = email;
    localStorage.setItem('wmmc_logged_in_email', email);
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

function initGoogleSignIn() {
  if (!GOOGLE_CLIENT_ID) {
    // Hide the divider and container if no Google client ID
    const container = document.getElementById('google-signin-container');
    const divider = container ? container.previousElementSibling : null;
    if (container) container.style.display = 'none';
    if (divider && divider.classList.contains('login-divider')) divider.style.display = 'none';
    return;
  }

  // Google GIS may load after this script; retry if not ready
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initGoogleSignIn, 500);
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
  });

  google.accounts.id.renderButton(document.getElementById('google-signin-container'), {
    theme: 'outline',
    size: 'large',
    width: '100%',
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

  select.addEventListener('change', async () => {
    SELECTED_SEASON = select.value;
    await syncFromServer();
    init();
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
  } catch (e) {
    console.error('Error rendering season:', e);
  }

  setupMyRoster();
  renderLeagueInfo();
  renderCommissioner();
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
      if (btn.dataset.tab === 'trends') renderTrends();
      if (btn.dataset.tab === 'hall-of-fame') renderHallOfFame();
    });
  });
}

// ============================================================
// Historical Season (completed)
// ============================================================
function showHistoricalSeason() {
  renderScoreboard();
  renderWeekly();
  renderPlayers();
  renderBracket();
}

// ============================================================
// SCOREBOARD - Combined Dashboard + Standings
// ============================================================
function renderScoreboard() {
  renderChampionBanner();
  renderScoreboardContent();
}

function renderChampionBanner() {
  const banner = document.getElementById('champion-banner');
  banner.className = 'champion-banner';

  const seasonComplete = DATA && DATA.bracket && DATA.bracket.finals && DATA.bracket.finals.winner;

  // Determine the reigning champion (champion of the most recent completed season)
  let reigningChampion = null;
  let reigningYear = null;
  if (seasonComplete) {
    reigningChampion = DATA.bracket.finals.winner;
    reigningYear = SELECTED_SEASON;
  } else {
    // Look back through historical results for the most recent champion before this season
    const hist = [...WMMC_HISTORICAL_RESULTS].reverse().find((r) => parseInt(r.year) < parseInt(SELECTED_SEASON));
    if (hist) {
      reigningChampion = hist.champion;
      reigningYear = hist.year;
    }
    // Also check localStorage seasons for prior champions (active seasons that were finalized)
    if (!reigningChampion) {
      const seasons = getSeasons();
      const years = Object.keys(seasons)
        .map(Number)
        .sort((a, b) => b - a);
      for (const yr of years) {
        if (String(yr) === String(SELECTED_SEASON)) continue;
        const priorSd = seasons[yr];
        if (!priorSd) continue;
        if (
          priorSd.status === 'completed' &&
          priorSd.data &&
          priorSd.data.bracket &&
          priorSd.data.bracket.finals &&
          priorSd.data.bracket.finals.winner
        ) {
          reigningChampion = priorSd.data.bracket.finals.winner;
          reigningYear = yr;
          break;
        }
        if (priorSd.champion) {
          reigningChampion = priorSd.champion;
          reigningYear = yr;
          break;
        }
      }
    }
  }

  // Determine footer for in-progress or preseason
  let footerHtml = '';
  if (!seasonComplete) {
    const sd = (getSeasons() || {})[SELECTED_SEASON];
    const period = sd ? getCurrentScoringPeriod(sd) : null;

    if (period) {
      // Season has data — show round name + week number
      const weekPart = `Week ${period.weekNum} of ${period.totalRoundWeeks}`;
      footerHtml = `<div class="banner-footer">${SELECTED_SEASON} Season In Progress &nbsp;|&nbsp; ${period.roundName} — ${weekPart}</div>`;
    } else {
      // No data yet — preseason
      const dates = sd ? sd.schedule_dates : null;
      let week1Part = '';
      if (dates && dates[0] && dates[0].start) {
        week1Part = ` &nbsp;|&nbsp; Week 1 starts ${fmtShortDate(dates[0].start)}`;
      }
      footerHtml = `<div class="banner-footer">${SELECTED_SEASON} Preseason${week1Part}</div>`;
    }
  }

  const rightHtml = reigningChampion
    ? `<div class="banner-right" style="display:flex;align-items:center;gap:0.75rem;">
        <div style="font-size:2.5rem;line-height:1;">&#127942;</div>
        <div>
          <div class="banner-champ-label">Reigning Champion</div>
          <div class="banner-champ-name">${reigningChampion}</div>
          <div class="banner-champ-year">${reigningYear} WMMC Champion</div>
        </div>
       </div>`
    : '';

  // Apply custom background if configured
  applyBannerBackground(banner, rightHtml, footerHtml);
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
    const ctx = canvas.getContext('2d');

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

  let html = '';

  // Pool Play section — collapsible when bracket data exists
  const ppCollapsed = hasBracket;
  html += `<div class="card scoreboard-card sb-poolplay-section">
    <div class="sb-poolplay-header" onclick="togglePoolPlay()">
      <h2 style="margin:0;border:none;padding:0;">Pool Play Scoreboard</h2>
      <span class="btn btn-sm btn-secondary sb-poolplay-toggle" id="sb-poolplay-toggle-btn">${ppCollapsed ? 'Show' : 'Hide'}</span>
    </div>
    <div class="sb-poolplay-body" id="sb-poolplay-body" style="display:${ppCollapsed ? 'none' : 'block'};">
      <div class="scoreboard-tabs" id="scoreboard-tabs">
        <button class="sb-tab active" data-period="pp-overall">Pool Play Overall</button>
        <button class="sb-tab" data-period="pp1">Pool Play 1</button>
        <button class="sb-tab" data-period="pp2">Pool Play 2</button>
        <button class="sb-tab" data-period="qf">Quarterfinals</button>
        <button class="sb-tab" data-period="sf">Semifinals</button>
        <button class="sb-tab" data-period="finals">Finals</button>
      </div>
      <div class="highlight-legend sb-color-legend">
        <span class="legend-label">Name Colors:</span>
        <span class="legend-item"><span class="legend-swatch hl-pp1"></span> PP1 Pool Leader</span>
        <span class="legend-item"><span class="legend-swatch hl-pp2"></span> PP2 Pool Leader</span>
        <span class="legend-item"><span class="legend-swatch hl-both"></span> PP1 &amp; PP2 Leader</span>
        <span class="legend-item"><span class="legend-swatch hl-wildcard"></span> Wild Card</span>
      </div>
      <div class="sb-period" id="sb-pp-overall">${renderPPOverallContent(leaders, seeding)}</div>
      <div class="sb-period" id="sb-pp1" style="display:none">${renderPoolPeriodContent('pp1')}</div>
      <div class="sb-period" id="sb-pp2" style="display:none">${renderPoolPeriodContent('pp2')}</div>
      <div class="sb-period" id="sb-qf" style="display:none">${renderQFContent()}</div>
      <div class="sb-period" id="sb-sf" style="display:none">${renderSFContent()}</div>
      <div class="sb-period" id="sb-finals" style="display:none">${renderFinalsContent()}</div>
    </div>
  </div>`;

  // Awards
  html += renderAwardsContent();

  container.innerHTML = html;
  setupScoreboardTabs();
}

window.togglePoolPlay = function () {
  const body = document.getElementById('sb-poolplay-body');
  const btn = document.getElementById('sb-poolplay-toggle-btn');
  if (!body || !btn) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  btn.textContent = hidden ? 'Hide' : 'Show';
};

window.togglePool = function (poolId) {
  const body = document.getElementById('pool-body-' + poolId);
  const btn = document.getElementById('pool-btn-' + poolId);
  if (!body || !btn) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  btn.textContent = isHidden ? '−' : '+';
};

// Expand/collapse every pool body in a given period at once.
window.toggleAllPools = function (period) {
  const buttons = document.querySelectorAll(`.pool-toggle-btn[data-period="${period}"]`);
  const allBtn = document.getElementById('toggle-all-btn-' + period);
  // If any pool is currently collapsed, expand them all; otherwise collapse them all.
  let anyCollapsed = false;
  buttons.forEach((btn) => {
    const poolId = btn.dataset.poolId;
    const body = document.getElementById('pool-body-' + poolId);
    if (body && body.style.display === 'none') anyCollapsed = true;
  });
  const targetDisplay = anyCollapsed ? '' : 'none';
  const targetLabel = anyCollapsed ? '−' : '+';
  buttons.forEach((btn) => {
    const poolId = btn.dataset.poolId;
    const body = document.getElementById('pool-body-' + poolId);
    if (body) body.style.display = targetDisplay;
    btn.textContent = targetLabel;
  });
  if (allBtn) allBtn.textContent = targetLabel;
};

window.togglePoolManagers = function (poolId) {
  const detailRows = document.querySelectorAll(`.sb-manager-detail-row[data-sb-pool="${poolId}"]`);
  const anyHidden = [...detailRows].some((row) => row.style.display === 'none');
  detailRows.forEach((row) => {
    const isHidden = row.style.display === 'none';
    if (anyHidden === isHidden) {
      const mgrKey = row.id.replace('mgr-detail-', '');
      window.toggleManagerDetails(mgrKey, row.dataset.manager);
    }
  });
  const btn = document.getElementById('pool-btn-' + poolId);
  if (btn) btn.textContent = anyHidden ? 'Hide' : 'Show';
};

window.toggleAllManagerDetails = function (period) {
  const detailRows = document.querySelectorAll(`.sb-manager-detail-row[data-sb-period="${period}"]`);
  const anyHidden = [...detailRows].some((row) => row.style.display === 'none');
  detailRows.forEach((row) => {
    const isHidden = row.style.display === 'none';
    if (anyHidden === isHidden) {
      const mgrKey = row.id.replace('mgr-detail-', '');
      window.toggleManagerDetails(mgrKey, row.dataset.manager);
    }
  });
  const btn = document.getElementById('toggle-all-mgr-btn-' + period);
  if (btn) btn.textContent = anyHidden ? 'Hide' : 'Show';
};

// Toggle the manager player detail pop-down in the scoreboard
window.toggleManagerDetails = function (mgrKey, managerName) {
  const row = document.getElementById('mgr-detail-' + mgrKey);
  const arrow = document.getElementById('sb-arrow-' + mgrKey);
  if (!row) return;

  if (row.style.display !== 'none') {
    row.style.display = 'none';
    if (arrow) arrow.innerHTML = '&#9660;';
    return;
  }

  const sd = getSeasons()[SELECTED_SEASON];
  if (!sd) {
    row.style.display = '';
    return;
  }

  const mgrRosters = (sd.rosters || {})[managerName] || {};
  const allBatters = new Set();
  const allPitchers = new Set();
  Object.values(mgrRosters).forEach((weekRoster) => {
    (weekRoster.batters || []).forEach((b) => allBatters.add(b));
    (weekRoster.pitchers || []).forEach((p) => allPitchers.add(p));
  });
  // Also include players who were dropped mid-week (appear in roster_dates but not roster arrays)
  const sbBatPool = new Set(sd.batters_pool || []);
  const sbPitPool = new Set(sd.pitchers_pool || []);
  const mgrRosterDates = (sd.roster_dates || {})[managerName] || {};
  Object.values(mgrRosterDates).forEach((weekDates) => {
    Object.keys(weekDates).forEach((player) => {
      if (sbBatPool.size === 0 || sbBatPool.has(player)) allBatters.add(player);
      if (sbPitPool.size === 0 || sbPitPool.has(player)) allPitchers.add(player);
    });
  });

  // Find current (most recent) roster
  const sortedWeeks = SEASON_SCHEDULE.map((s) => `${s.round}|${s.week}`).filter((k) => mgrRosters[k]);
  const currentWeekKey = sortedWeeks[sortedWeeks.length - 1] || null;
  const currentRoster = currentWeekKey ? mgrRosters[currentWeekKey] : { batters: [], pitchers: [] };
  const activeBatters = new Set(currentRoster.batters || []);
  const activePitchers = new Set(currentRoster.pitchers || []);
  // Track the opening-week roster so we can tell original players from mid-season adds
  const firstWeekKey = sortedWeeks[0] || null;
  const firstRoster = firstWeekKey
    ? mgrRosters[firstWeekKey] || { batters: [], pitchers: [] }
    : { batters: [], pitchers: [] };

  // Compute total points per player (includes null-manager entries for players rostered that week)
  const detailRosterLookup = buildRosterLookup(sd);
  function playerPts(name, type) {
    const arr = type === 'batting' ? sd.weekly_batting || [] : sd.weekly_pitching || [];
    const playerKey = type === 'batting' ? 'batter' : 'pitcher';
    return (
      Math.round(
        arr
          .filter((r) => {
            if (r[playerKey] !== name) return false;
            const mgr = r.manager || detailRosterLookup[`${name}|${r.round}|${r.week}`];
            return mgr === managerName;
          })
          .reduce((s, r) => s + (r.weekly_score || 0), 0) * 100
      ) / 100
    );
  }

  // Find player roster history: first/last week seen, swap reason
  function playerHistory(name, batOrPit) {
    let addDate = null,
      dropDate = null,
      swapReason = null;

    // Walk through schedule weeks in order
    let seenActive = false;
    for (const sched of SEASON_SCHEDULE) {
      const wk = `${sched.round}|${sched.week}`;
      const weekRoster = mgrRosters[wk];
      if (!weekRoster) continue;
      const onRoster = (weekRoster[batOrPit] || []).includes(name);
      if (onRoster && !seenActive) {
        // Find week start date
        const wi = SEASON_SCHEDULE.findIndex((s) => s.round === sched.round && s.week === sched.week);
        const dates = sd.schedule_dates;
        addDate = dates && dates[wi] ? fmtShortDate(dates[wi].start) : wk;
        seenActive = true;
      } else if (!onRoster && seenActive && !dropDate) {
        const wi = SEASON_SCHEDULE.findIndex((s) => s.round === sched.round && s.week === sched.week);
        const dates = sd.schedule_dates;
        dropDate = dates && dates[wi] ? fmtShortDate(dates[wi].start) : wk;
      }
    }

    // Check explicit roster_dates
    const rdDates = (sd.roster_dates || {})[managerName] || {};
    for (const players of Object.values(rdDates)) {
      if (players[name]) {
        if (players[name].add_date) addDate = fmtShortDate(players[name].add_date);
        if (players[name].drop_date) dropDate = fmtShortDate(players[name].drop_date);
      }
    }

    // Check swaps
    const swaps = (sd.swaps || []).filter(
      (s) => s.manager === managerName && s.player_out === name && s.status === 'approved'
    );
    if (swaps.length > 0) {
      const last = swaps[swaps.length - 1];
      swapReason = last.reason;
      if (last.swap_date) dropDate = fmtShortDate(last.swap_date);
    }

    return { addDate, dropDate, swapReason };
  }

  // Build HTML for the pop-down
  function buildPlayerRows(names, type, activeSet) {
    const batOrPit = type === 'batting' ? 'batters' : 'pitchers';
    if (names.size === 0) return '<tr><td colspan="3" class="text-muted" style="font-size:0.82rem;">None</td></tr>';
    // Convert "Mon DD" string (from fmtShortDate) → "M/DD"
    const toMD = (s) => {
      if (!s) return '';
      const mo = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
      const [mon, day] = s.split(' ');
      const m = mo[mon];
      return m ? `${m}/${String(parseInt(day)).padStart(2, '0')}` : s;
    };
    return [...names]
      .sort()
      .map((name) => {
        const pts = playerPts(name, type);
        const isActive = activeSet.has(name);
        const { addDate, dropDate } = playerHistory(name, batOrPit);
        const wasOriginal = (firstRoster[batOrPit] || []).includes(name);
        // Only show a date range when the player was actually swapped in or out
        let dateCell = '';
        if (!isActive) {
          const s = toMD(addDate),
            e = toMD(dropDate);
          dateCell = s && e ? `${s}–${e}` : e || s;
        } else if (!wasOriginal && addDate) {
          dateCell = `${toMD(addDate)}–`;
        }
        const safeName = jsStr(name);
        const safeMgr = jsStr(managerName);
        return `<tr class="${isActive ? '' : 'dropped-player'}">
        <td>${name}</td>
        <td class="num"><button class="pqv-pts-btn" onclick="showPlayerQuickView('${safeName}','${type}','${safeMgr}')"><strong>${fmt(pts)}</strong></button></td>
        <td class="mgr-detail-date">${dateCell}</td>
      </tr>`;
      })
      .join('');
  }

  const colspan = row.querySelector('td').getAttribute('colspan') || '6';
  row.innerHTML = `<td colspan="${colspan}">
    <div class="mgr-detail-panel">
      <div class="mgr-detail-cols">
        <div class="mgr-detail-section">
          <div class="mgr-detail-header">Batters</div>
          <table class="data-table compact-table"><thead><tr><th>Player</th><th>Pts</th><th></th></tr></thead>
          <tbody>${buildPlayerRows(allBatters, 'batting', activeBatters)}</tbody></table>
        </div>
        <div class="mgr-detail-section">
          <div class="mgr-detail-header">Pitchers</div>
          <table class="data-table compact-table"><thead><tr><th>Player</th><th>Pts</th><th></th></tr></thead>
          <tbody>${buildPlayerRows(allPitchers, 'pitching', activePitchers)}</tbody></table>
        </div>
      </div>
    </div>
  </td>`;

  row.style.display = '';
  if (arrow) arrow.innerHTML = '&#9650;';
};

window.showPlayerQuickView = function (playerName, type, managerName) {
  const sd = getSeasons()[SELECTED_SEASON];
  if (!sd) return;

  const dates = getScheduleDates();
  const isBat = type === 'batting';
  const arr = isBat ? sd.weekly_batting || [] : sd.weekly_pitching || [];
  const playerKey = isBat ? 'batter' : 'pitcher';

  const pqvRosterLookup = buildRosterLookup(sd);
  const records = arr
    .filter((r) => {
      if (r[playerKey] !== playerName) return false;
      const mgr = r.manager || pqvRosterLookup[`${playerName}|${r.round}|${r.week}`];
      return mgr === managerName;
    })
    .sort((a, b) => weekIndexFromKey(a.round, a.week) - weekIndexFromKey(b.round, b.week));

  let tableHtml = '';
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
        <td>${r.week || ''}</td>${dates ? `<td class="week-dates">${ds}</td>` : ''}
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
        <td>${r.week || ''}</td>${dates ? `<td class="week-dates">${ds}</td>` : ''}
        <td class="num">${r.gs || 0}</td><td class="num">${r.w || 0}</td>
        <td class="num">${r.qs_highlight ? '&mdash;' : fmtDec(r.qs)}</td>
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

function setupScoreboardTabs() {
  const tabs = document.querySelectorAll('.sb-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.sb-period').forEach((p) => (p.style.display = 'none'));
      tab.classList.add('active');
      const target = document.getElementById('sb-' + tab.dataset.period);
      if (target) target.style.display = 'block';
    });
  });
}

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
    <button class="pool-expand-all-btn" id="toggle-all-btn-${period}" data-period="${period}" onclick="toggleAllPools('${period}')">−</button>
  </div>`;
  html += '<div class="pool-play-grid">';

  for (const [poolName, members] of Object.entries(pools)) {
    const poolEntries = poolPlay.filter((p) => members.includes(p.manager)).sort((a, b) => a[rankKey] - b[rankKey]);
    const safePoolId = `${period}_${poolName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')}`;

    html += `<div class="pool-card">
      <div class="pool-card-header">
        <h4>${poolName}</h4>
        <button class="pool-toggle-btn" id="pool-btn-${safePoolId}" data-period="${period}" data-pool-id="${safePoolId}" onclick="togglePool('${safePoolId}')">−</button>
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
      let seedType = '';
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

function renderMatchupResultCard(m) {
  if (!m) return '';
  const label = m.label ? `<div class="matchup-label">${m.label}</div>` : '';
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
function renderWeekly() {
  if (!DATA || !DATA.team_weekly) {
    document.getElementById('weekly-table').innerHTML =
      '<tbody><tr><td>No weekly data available for this season.</td></tr></tbody>';
    return;
  }

  const rounds = [...new Set(DATA.team_weekly.map((t) => t.round))];
  const weeks = [...new Set(DATA.team_weekly.map((t) => t.week))];
  const managers = [...new Set(DATA.team_weekly.map((t) => t.manager))].sort();

  resetSelect('weekly-round-filter', rounds);
  resetSelect('weekly-week-filter', weeks);
  resetSelect('weekly-manager-filter', managers);

  const update = () => {
    const roundF = document.getElementById('weekly-round-filter').value;
    const weekF = document.getElementById('weekly-week-filter').value;
    const managerF = document.getElementById('weekly-manager-filter').value;

    let filtered = DATA.team_weekly;
    if (roundF !== 'all') filtered = filtered.filter((t) => t.round === roundF);
    if (weekF !== 'all') filtered = filtered.filter((t) => t.week === weekF);
    if (managerF !== 'all') filtered = filtered.filter((t) => t.manager === managerF);

    const dates = getScheduleDates();
    const table = document.getElementById('weekly-table');
    table.classList.add('compact-table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Rnd</th><th>Wk</th>${dates ? '<th>Dates</th>' : ''}<th>Manager</th><th>Pool</th>
          <th>Bat</th><th>Bat Rk</th>
          <th>Pit</th><th>Pit Rk</th>
          <th>Total</th><th>Tot Rk</th>
          <th>Cum Bat</th><th>Cum Pit</th><th>Cum Tot</th>
          <th>Pool Rk</th>
        </tr>
      </thead>
      <tbody>
        ${filtered
          .map((t) => {
            const wi = weekIndexFromKey(t.round, t.week);
            const dateStr = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
            return `
          <tr>
            <td>${t.round || ''}</td>
            <td>${t.week || ''}</td>
            ${dates ? `<td class="week-dates">${dateStr}</td>` : ''}
            <td><strong>${t.manager}</strong></td>
            <td>${t.pool || ''}</td>
            <td class="num">${fmt(t.weekly_batting)}</td>
            <td class="rank">${t.weekly_batting_rank || ''}</td>
            <td class="num">${fmt(t.weekly_pitching)}</td>
            <td class="rank">${t.weekly_pitching_rank || ''}</td>
            <td class="num"><strong>${fmt(t.weekly_total)}</strong></td>
            <td class="rank">${t.weekly_total_rank || ''}</td>
            <td class="num">${fmt(t.batting_total_by_round)}</td>
            <td class="num">${fmt(t.pitching_total_by_round)}</td>
            <td class="num">${fmt(t.team_score_by_round)}</td>
            <td class="rank">${t.pool_rank_by_week || ''}</td>
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

  const rounds = [
    ...new Set(DATA.batting_weekly.map((b) => b.round).concat(DATA.pitching_weekly.map((p) => p.round))),
  ].filter(Boolean);
  const weeks = [
    ...new Set(DATA.batting_weekly.map((b) => b.week).concat(DATA.pitching_weekly.map((p) => p.week))),
  ].filter(Boolean);
  const managers = [
    ...new Set(DATA.batting_weekly.map((b) => b.manager).concat(DATA.pitching_weekly.map((p) => p.manager))),
  ]
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
      let filtered = DATA.batting_weekly;
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
              <td>${b.week || ''}</td>
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
      let filtered = DATA.pitching_weekly;
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
              <td>${p.week || ''}</td>
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
function renderBracket() {
  const container = document.getElementById('scoreboard-bracket');
  if (!container) return;
  if (!DATA || !DATA.bracket) {
    container.innerHTML = '';
    return;
  }

  const b = DATA.bracket;

  function matchupHTML(m, showLabel) {
    if (!m) return '<div class="matchup"><div class="matchup-team"><span class="team-name">TBD</span></div></div>';
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
      const roundLabels = {
        PP1: 'Pool Play 1',
        PP2: 'Pool Play 2',
        QF: 'Quarterfinals',
        SF: 'Semifinals',
        Finals: 'Finals',
      };
      const periodKey = { PP1: 'pp1', PP2: 'pp2', QF: 'qf', SF: 'sf', Finals: 'finals' }[s.round];
      let deadlineHtml = '';
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
        if (openDate) parts.push(`Opens ${fmtDt(openDate)}`);
        if (deadline) parts.push(`Deadline ${fmtDt(deadline)}`);
        if (parts.length) {
          deadlineHtml = `<span class="tl-submission-deadline">${parts.join(' &nbsp;·&nbsp; ')}</span>`;
        }
      }
      html += `<div class="tl-round-label">${roundLabels[s.round] || s.round}${deadlineHtml}</div>`;
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
    setupScoreboardTabs();
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

    // If pool play is finalized, minimize pool play section and feature bracket
    if (ppFinalized) {
      const ppBody = document.getElementById('sb-poolplay-body');
      const ppBtn = document.getElementById('sb-poolplay-toggle-btn');
      if (ppBody) ppBody.style.display = 'none';
      if (ppBtn) ppBtn.textContent = 'Show';
    }
  }
}

// Build an active season playoff bracket (tentative or finalized)
function buildActivePlayoffBracket(seasonData, ppFinalized) {
  const managerScores = computeManagerScores(seasonData);
  if (managerScores.length === 0) return '';

  // Compute seeding from pool play scores (active managers only)
  const managers = getManagers();
  const poolGroups = {};
  managers.forEach((m) => {
    if (m.pool && m.active !== false) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });

  // Compute PP1 and PP2 scores per manager
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  const mgrPPScores = {};

  managerScores.forEach((ms) => {
    mgrPPScores[ms.manager] = { pp1: 0, pp2: 0, total: ms.total, pool: null };
  });

  const bracketRosterLookup = buildRosterLookup(seasonData);
  batting.forEach((b) => {
    const mgr = b.manager || bracketRosterLookup[`${esc(b.batter)}|${b.round}|${b.week}`];
    if (!mgr || !mgrPPScores[mgr]) return;
    const weekKey = `${b.round}|${b.week}`;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.batters.includes(b.batter) && !weekRosterDates[b.batter]) return;
    if (b.round === 'PP1') mgrPPScores[mgr].pp1 += b.weekly_score || 0;
    if (b.round === 'PP2') mgrPPScores[mgr].pp2 += b.weekly_score || 0;
  });
  pitching.forEach((p) => {
    const mgr = p.manager || bracketRosterLookup[`${esc(p.pitcher)}|${p.round}|${p.week}`];
    if (!mgr || !mgrPPScores[mgr]) return;
    const weekKey = `${p.round}|${p.week}`;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.pitchers.includes(p.pitcher) && !weekRosterDates[p.pitcher]) return;
    if (p.round === 'PP1') mgrPPScores[mgr].pp1 += p.weekly_score || 0;
    if (p.round === 'PP2') mgrPPScores[mgr].pp2 += p.weekly_score || 0;
  });

  managers.forEach((m) => {
    if (mgrPPScores[m.name]) mgrPPScores[m.name].pool = m.pool;
  });

  // Find pool leaders (PP1 and PP2)
  const pp1Leaders = new Set();
  const pp2Leaders = new Set();
  for (const members of Object.values(poolGroups)) {
    let bestPP1 = null,
      bestPP1Score = -Infinity;
    let bestPP2 = null,
      bestPP2Score = -Infinity;
    members.forEach((name) => {
      const s = mgrPPScores[name];
      if (s && s.pp1 > bestPP1Score) {
        bestPP1 = name;
        bestPP1Score = s.pp1;
      }
      if (s && s.pp2 > bestPP2Score) {
        bestPP2 = name;
        bestPP2Score = s.pp2;
      }
    });
    if (bestPP1) pp1Leaders.add(bestPP1);
    if (bestPP2) pp2Leaders.add(bestPP2);
  }

  const allLeaders = new Set([...pp1Leaders, ...pp2Leaders]);
  const wildcardsNeeded = Math.max(0, 8 - allLeaders.size);

  // Get PP totals for seeding
  const ppTotals = {};
  Object.entries(mgrPPScores).forEach(([name, s]) => {
    ppTotals[name] = s.pp1 + s.pp2;
  });

  const nonLeaders = Object.keys(ppTotals)
    .filter((n) => !allLeaders.has(n))
    .sort((a, b) => ppTotals[b] - ppTotals[a]);
  const wildcards = nonLeaders.slice(0, wildcardsNeeded);

  const qualifiers = [...[...allLeaders].sort((a, b) => ppTotals[b] - ppTotals[a]), ...wildcards];
  if (qualifiers.length < 8) {
    // Not enough managers to form a bracket
    return `<div class="card"><h2>Playoff Bracket ${!ppFinalized ? '<span class="badge badge-wildcard">Tentative</span>' : ''}</h2>
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

  // Compute round scores for matchups (with batting/pitching breakdown)
  function getRoundBreakdown(manager, round) {
    let bat = 0,
      pit = 0;
    batting
      .filter((b) => (b.manager === manager || b.manager === null) && b.round === round)
      .forEach((b) => {
        const weekKey = `${b.round}|${b.week}`;
        const wr = (seasonData.rosters && seasonData.rosters[manager] && seasonData.rosters[manager][weekKey]) || {
          batters: [],
        };
        const wrd =
          (seasonData.roster_dates && seasonData.roster_dates[manager] && seasonData.roster_dates[manager][weekKey]) ||
          {};
        if (wr.batters.includes(b.batter) || wrd[b.batter]) bat += b.weekly_score || 0;
      });
    pitching
      .filter((p) => (p.manager === manager || p.manager === null) && p.round === round)
      .forEach((p) => {
        const weekKey = `${p.round}|${p.week}`;
        const wr = (seasonData.rosters && seasonData.rosters[manager] && seasonData.rosters[manager][weekKey]) || {
          pitchers: [],
        };
        const wrd =
          (seasonData.roster_dates && seasonData.roster_dates[manager] && seasonData.roster_dates[manager][weekKey]) ||
          {};
        if (wr.pitchers.includes(p.pitcher) || wrd[p.pitcher]) pit += p.weekly_score || 0;
      });
    bat = Math.round(bat * 100) / 100;
    pit = Math.round(pit * 100) / 100;
    const total = Math.round((bat + pit) * 100) / 100;
    return { bat, pit, total };
  }
  function bracketScoreHtml(bd) {
    if (bd.total <= 0) return '<span class="bracket-score">-</span>';
    return `<span class="bracket-score-group">
      <span class="bracket-score">${fmt(bd.total)}</span>
      <span class="bracket-score-detail">${fmt(bd.bat)}B / ${fmt(bd.pit)}P</span>
    </span>`;
  }

  const finalized = seasonData.finalized_rounds || [];
  const tentativeLabel = !ppFinalized ? ' <span class="badge badge-wildcard">Tentative</span>' : '';

  let html = `<div class="card bracket-card ${ppFinalized ? 'bracket-featured' : ''}">
    <h2>Playoff Bracket${tentativeLabel}</h2>
    <div class="active-bracket">`;

  // QF column
  html += '<div class="bracket-round"><div class="bracket-round-label">Quarterfinals</div>';
  const qfWinners = [];
  qfMatchups.forEach((m) => {
    const s1Bd = getRoundBreakdown(m.s1.name, 'QF');
    const s2Bd = getRoundBreakdown(m.s2.name, 'QF');
    const qfDone = finalized.includes('QF');
    const winner = qfDone ? (s1Bd.total >= s2Bd.total ? m.s1.name : m.s2.name) : null;
    qfWinners.push(winner);
    html += `<div class="bracket-matchup">
      <div class="bracket-matchup-label">${m.label}</div>
      <div class="bracket-team ${winner === m.s1.name ? 'bracket-winner' : ''}">
        <span class="bracket-seed">${m.s1.seed}</span>
        <span class="bracket-name">${m.s1.name}</span>
        ${bracketScoreHtml(s1Bd)}
      </div>
      <div class="bracket-team ${winner === m.s2.name ? 'bracket-winner' : ''}">
        <span class="bracket-seed">${m.s2.seed}</span>
        <span class="bracket-name">${m.s2.name}</span>
        ${bracketScoreHtml(s2Bd)}
      </div>
    </div>`;
  });
  html += '</div>';

  // SF column
  html += '<div class="bracket-round"><div class="bracket-round-label">Semifinals</div>';
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
    const winner = sfDone && m.t1 !== 'TBD' && m.t2 !== 'TBD' ? (s1Bd.total >= s2Bd.total ? m.t1 : m.t2) : null;
    const loser = sfDone && m.t1 !== 'TBD' && m.t2 !== 'TBD' ? (s1Bd.total >= s2Bd.total ? m.t2 : m.t1) : null;
    sfWinners.push(winner);
    sfLosers.push(loser);
    html += `<div class="bracket-matchup">
      <div class="bracket-matchup-label">${m.label}</div>
      <div class="bracket-team ${winner === m.t1 ? 'bracket-winner' : ''}">
        <span class="bracket-name">${m.t1}</span>
        ${m.t1 !== 'TBD' ? bracketScoreHtml(s1Bd) : '<span class="bracket-score">-</span>'}
      </div>
      <div class="bracket-team ${winner === m.t2 ? 'bracket-winner' : ''}">
        <span class="bracket-name">${m.t2}</span>
        ${m.t2 !== 'TBD' ? bracketScoreHtml(s2Bd) : '<span class="bracket-score">-</span>'}
      </div>
    </div>`;
  });
  html += '</div>';

  // Finals column
  html += '<div class="bracket-round"><div class="bracket-round-label">Finals</div>';
  const f1 = sfWinners[0] || 'TBD';
  const f2 = sfWinners[1] || 'TBD';
  const f1Bd = f1 !== 'TBD' ? getRoundBreakdown(f1, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const f2Bd = f2 !== 'TBD' ? getRoundBreakdown(f2, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const finalsDone = finalized.includes('Finals');
  const champion = finalsDone && f1 !== 'TBD' && f2 !== 'TBD' ? (f1Bd.total >= f2Bd.total ? f1 : f2) : null;

  html += `<div class="bracket-matchup">
    <div class="bracket-matchup-label">Championship</div>
    <div class="bracket-team ${champion === f1 ? 'bracket-winner bracket-champion' : ''}">
      <span class="bracket-name">${f1}</span>
      ${f1 !== 'TBD' ? bracketScoreHtml(f1Bd) : '<span class="bracket-score">-</span>'}
    </div>
    <div class="bracket-team ${champion === f2 ? 'bracket-winner bracket-champion' : ''}">
      <span class="bracket-name">${f2}</span>
      ${f2 !== 'TBD' ? bracketScoreHtml(f2Bd) : '<span class="bracket-score">-</span>'}
    </div>
  </div>`;

  // 3rd Place
  const t1 = sfLosers[0] || 'TBD';
  const t2 = sfLosers[1] || 'TBD';
  const t1Bd = t1 !== 'TBD' ? getRoundBreakdown(t1, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const t2Bd = t2 !== 'TBD' ? getRoundBreakdown(t2, 'Finals') : { bat: 0, pit: 0, total: 0 };
  const thirdPlace = finalsDone && t1 !== 'TBD' && t2 !== 'TBD' ? (t1Bd.total >= t2Bd.total ? t1 : t2) : null;

  html += `<div class="bracket-matchup" style="margin-top:1rem;">
    <div class="bracket-matchup-label">3rd Place</div>
    <div class="bracket-team ${thirdPlace === t1 ? 'bracket-winner' : ''}">
      <span class="bracket-name">${t1}</span>
      ${t1 !== 'TBD' ? bracketScoreHtml(t1Bd) : '<span class="bracket-score">-</span>'}
    </div>
    <div class="bracket-team ${thirdPlace === t2 ? 'bracket-winner' : ''}">
      <span class="bracket-name">${t2}</span>
      ${t2 !== 'TBD' ? bracketScoreHtml(t2Bd) : '<span class="bracket-score">-</span>'}
    </div>
  </div>`;

  html += '</div></div></div>';
  return html;
}

function renderActiveScoreboardTabs(seasonData, managerScores, managers) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  // Pool groups from manager pool assignments (active managers only)
  const poolGroups = {};
  managers.forEach((m) => {
    if (m.pool && m.active !== false) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });
  const hasPools = Object.keys(poolGroups).length > 0;

  const sbRosterLookup = buildRosterLookup(seasonData);

  // Compute per-period scores — include ALL pool-assigned managers at 0
  function periodScores(roundFilter) {
    const mgrMap = {};
    managers.forEach((m) => {
      if (m.pool && m.active !== false) mgrMap[m.name] = { manager: m.name, batting: 0, pitching: 0, total: 0 };
    });
    batting
      .filter((b) => roundFilter.includes(b.round))
      .forEach((b) => {
        const mgr = b.manager || sbRosterLookup[`${esc(b.batter)}|${b.round}|${b.week}`];
        if (!mgr) return;
        const weekKey = `${b.round}|${b.week}`;
        const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
          batters: [],
          pitchers: [],
        };
        const weekRosterDates =
          (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
        if (!weekRoster.batters.includes(b.batter) && !weekRosterDates[b.batter]) return;
        if (!mgrMap[mgr]) mgrMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
        mgrMap[mgr].batting += b.weekly_score || 0;
      });
    pitching
      .filter((p) => roundFilter.includes(p.round))
      .forEach((p) => {
        const mgr = p.manager || sbRosterLookup[`${esc(p.pitcher)}|${p.round}|${p.week}`];
        if (!mgr) return;
        const weekKey = `${p.round}|${p.week}`;
        const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
          batters: [],
          pitchers: [],
        };
        const weekRosterDates =
          (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
        if (!weekRoster.pitchers.includes(p.pitcher) && !weekRosterDates[p.pitcher]) return;
        if (!mgrMap[mgr]) mgrMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
        mgrMap[mgr].pitching += p.weekly_score || 0;
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

  // ---- Determine PP1 and PP2 pool winners ----
  const pp1Winners = {}; // poolNum → manager name
  const pp2Winners = {};
  Object.keys(poolGroups).forEach((poolNum) => {
    const poolMembers = poolGroups[poolNum];
    const pp1Pool = pp1Scores.filter((s) => poolMembers.includes(s.manager)).sort((a, b) => b.total - a.total);
    if (pp1Pool.length > 0 && pp1Pool[0].total > 0) pp1Winners[poolNum] = pp1Pool[0].manager;
    const pp2Pool = pp2Scores.filter((s) => poolMembers.includes(s.manager)).sort((a, b) => b.total - a.total);
    if (pp2Pool.length > 0 && pp2Pool[0].total > 0) pp2Winners[poolNum] = pp2Pool[0].manager;
  });

  const pp1WinnerSet = new Set(Object.values(pp1Winners));
  const pp2WinnerSet = new Set(Object.values(pp2Winners));
  const allPPWinners = new Set([...pp1WinnerSet, ...pp2WinnerSet]);

  // Wildcards: 8 - unique_pool_play_winners = wildcard spots
  const numWildcards = Math.max(0, 8 - allPPWinners.size);
  const wildcardSet = new Set();
  let wcCount = 0;
  for (const m of overallScores) {
    if (wcCount >= numWildcards) break;
    if (!allPPWinners.has(m.manager) && m.total > 0) {
      wildcardSet.add(m.manager);
      wcCount++;
    }
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
        <h3>Pool ${poolNum} <button class="pool-toggle-btn" id="pool-btn-${safePoolId}" data-pool-id="${safePoolId}" onclick="event.stopPropagation();togglePoolManagers('${safePoolId}')">Show</button></h3>
        <table class="data-table compact-table">
          <thead><tr><th>#</th><th>Manager</th><th>Bat</th><th>Pit</th><th>Total</th></tr></thead>
          <tbody>`;
        poolScores.forEach((m, i) => {
          const cls = hlClass(m.manager, section);
          const mgrKey = m.manager.replace(/[^a-zA-Z0-9]/g, '_');
          html += `<tr class="sb-manager-row" onclick="toggleManagerDetails('${mgrKey}','${jsStr(m.manager)}')">
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
      <thead><tr><th>#</th><th>Manager</th><th>Pool</th><th>B</th><th>P</th><th>Total</th></tr></thead><tbody>`;
    scores.forEach((m, i) => {
      const cls = hlClass(m.manager, 'overall');
      const mgrKey = m.manager.replace(/[^a-zA-Z0-9]/g, '_') + '_ov';
      tbl += `<tr class="sb-manager-row" onclick="toggleManagerDetails('${mgrKey}','${jsStr(m.manager)}')">
        <td class="rank">${i + 1}</td>
        <td><strong class="${cls}">${esc(m.manager)}</strong>${m.manager === overallLastMgr ? ' <span class="last-place-icon" title="Last place">🗑️💦</span>' : ''} <span class="sb-expand-arrow" id="sb-arrow-${mgrKey}">&#9660;</span></td>
        <td>${mgrPool[m.manager] || ''}</td>
        <td class="num">${fmt(m.batting)}</td>
        <td class="num">${fmt(m.pitching)}</td>
        <td class="num"><strong>${fmt(m.total)}</strong></td>
      </tr>
      <tr class="sb-manager-detail-row" id="mgr-detail-${mgrKey}" data-manager="${esc(m.manager)}" style="display:none;">
        <td colspan="6"><div class="mgr-detail-loading">Loading...</div></td>
      </tr>`;
    });
    tbl += '</tbody></table>';
    return tbl;
  }

  // ---- Build full HTML ----
  // Check if playoff data exists — if so, pool play starts collapsed
  const rounds = new Set([...batting.map((b) => b.round), ...pitching.map((p) => p.round)]);
  const hasPlayoffData = rounds.has('QF') || rounds.has('SF') || rounds.has('Finals');
  const ppCollapsed = hasPlayoffData;

  let html = '';

  html += `<div class="card scoreboard-card sb-poolplay-section">
    <div class="sb-poolplay-header" onclick="togglePoolPlay()">
      <h2 style="margin:0;border:none;padding:0;">Pool Play Scoreboard</h2>
      <span class="btn btn-sm btn-secondary sb-poolplay-toggle" id="sb-poolplay-toggle-btn">${ppCollapsed ? 'Show' : 'Hide'}</span>
    </div>
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

  // Pool Play leader stat cards (pool play scores only)
  if (overallScores.length > 0 && overallScores[0].total > 0) {
    const ppSorted = [...overallScores].sort((a, b) => b.total - a.total);
    const ppTop = ppSorted[0];
    const ppBestBat = [...overallScores].sort((a, b) => b.batting - a.batting)[0];
    const ppBestPit = [...overallScores].sort((a, b) => b.pitching - a.pitching)[0];
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
  html += `<div class="scoreboard-section">
    <h3 class="pool-period-header">Pool Play 1 <button class="pool-expand-all-btn" id="toggle-all-mgr-btn-pp1" onclick="toggleAllManagerDetails('pp1')">Show</button></h3>
    ${renderPoolSection(pp1Scores, 'Pool Play 1', 'pp1')}
  </div>`;

  // Pool Play 2
  html += `<div class="scoreboard-section">
    <h3 class="pool-period-header">Pool Play 2 <button class="pool-expand-all-btn" id="toggle-all-mgr-btn-pp2" onclick="toggleAllManagerDetails('pp2')">Show</button></h3>
    ${renderPoolSection(pp2Scores, 'Pool Play 2', 'pp2')}
  </div>`;

  // Playoff Advancement summary
  if (allPPWinners.size > 0 || wildcardSet.size > 0) {
    html += `<div class="scoreboard-section">
      <h3>Playoff Advancement</h3>
      <div class="advancement-summary">
        <p><strong>Pool Play Winners (${allPPWinners.size}):</strong> ${[...allPPWinners].sort().join(', ') || 'TBD'}</p>
        <p><strong>Wild Cards (${numWildcards} spot${numWildcards !== 1 ? 's' : ''}):</strong> ${[...wildcardSet].sort().join(', ') || 'TBD'}</p>
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

  // Playoff period tabs (QF / SF / Finals) — only if data exists
  const hasQF = rounds.has('QF');
  const hasSF = rounds.has('SF');
  const hasFinals = rounds.has('Finals');

  if (hasQF || hasSF || hasFinals) {
    let tabsHtml = '';
    let first = true;
    [
      { key: 'qf', has: hasQF, label: 'Quarterfinals' },
      { key: 'sf', has: hasSF, label: 'Semifinals' },
      { key: 'finals', has: hasFinals, label: 'Finals' },
    ].forEach((t) => {
      if (!t.has) return;
      tabsHtml += `<button class="sb-tab ${first ? 'active' : ''}" data-period="${t.key}">${t.label}</button>`;
      first = false;
    });

    const renderPlayoffTable = (scores) => {
      if (scores.length === 0) return '<p>No data.</p>';
      let tbl = `<table class="data-table compact-table">
        <thead><tr><th>#</th><th>Manager</th><th>Bat</th><th>Pit</th><th>Total</th></tr></thead><tbody>`;
      scores.forEach((m, i) => {
        tbl += `<tr>
          <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
          <td><strong>${esc(m.manager)}</strong></td>
          <td class="num">${fmt(m.batting)}</td>
          <td class="num">${fmt(m.pitching)}</td>
          <td class="num"><strong>${fmt(m.total)}</strong></td>
        </tr>`;
      });
      tbl += '</tbody></table>';
      return tbl;
    };

    html += `<div class="card scoreboard-card">
      <div class="scoreboard-tabs" id="scoreboard-tabs">${tabsHtml}</div>`;
    let firstPeriod = true;
    if (hasQF) {
      html += `<div class="sb-period" id="sb-qf" ${!firstPeriod ? 'style="display:none"' : ''}>${renderPlayoffTable(periodScores(['QF']))}</div>`;
      firstPeriod = false;
    }
    if (hasSF) {
      html += `<div class="sb-period" id="sb-sf" ${!firstPeriod ? 'style="display:none"' : ''}>${renderPlayoffTable(periodScores(['SF']))}</div>`;
      firstPeriod = false;
    }
    if (hasFinals) {
      html += `<div class="sb-period" id="sb-finals" ${!firstPeriod ? 'style="display:none"' : ''}>${renderPlayoffTable(periodScores(['Finals']))}</div>`;
      firstPeriod = false;
    }
    html += '</div>';
  }

  return html;
}

function renderActiveWeekly(seasonData) {
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
        const mgr = b.manager || trendsRosterLookup[`${esc(b.batter)}|${b.round}|${b.week}`];
        return mgr
          ? { player: b.batter, manager: mgr, round: b.round, week: b.week, weekly_score: b.weekly_score || 0 }
          : null;
      })
      .filter(Boolean);
    pitchingData = (seasonData.weekly_pitching || [])
      .map((p) => {
        const mgr = p.manager || trendsRosterLookup[`${esc(p.pitcher)}|${p.round}|${p.week}`];
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
  let managerMode = 'weekly';
  const mgrsForBatters = new Set(allManagers);
  const mgrsForPitchers = new Set(allManagers);
  let selectedBatters = new Set();
  let selectedPitchers = new Set();

  // ---- Pool filter buttons HTML ----
  const poolBtnsHtml = hasPools
    ? `<div class="trends-control-row">
            <span class="trends-label">By Pool</span>
            ${poolNums.map((p) => `<button class="btn btn-sm btn-secondary pool-filter-btn" data-pool="${p}">Pool ${p}</button>`).join('')}
          </div>`
    : '';
  const mgrPoolBtnsHtml = (prefix) =>
    hasPools
      ? `<div class="trends-control-row">
            <span class="trends-label">By Pool</span>
            ${poolNums.map((p) => `<button class="btn btn-sm btn-secondary pool-filter-btn" data-pool="${p}" data-prefix="${prefix}">Pool ${p}</button>`).join('')}
          </div>`
      : '';

  // ---- Build HTML ----
  container.innerHTML = `
    <div class="card">
      <div class="player-type-toggle trends-view-toggle">
        <button class="type-btn active" data-view="managers">Manager Trends</button>
        <button class="type-btn" data-view="batters">Batters</button>
        <button class="type-btn" data-view="pitchers">Pitchers</button>
      </div>

      <!-- Manager Trends -->
      <div id="trends-managers-panel" class="trends-panel">
        <div class="trends-controls">
          <div class="trends-control-row">
            <span class="trends-label">View Mode</span>
            <div class="player-type-toggle" style="display:inline-flex;">
              <button class="type-btn active" id="mode-weekly">Weekly</button>
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
  function makeChart(canvasId, datasets, yLabel) {
    if (_trendsCharts[canvasId]) {
      try {
        _trendsCharts[canvasId].destroy();
      } catch {
        /* chart already gone */
      }
    }
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return;
    _trendsCharts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: { labels: chartLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 10 } },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? fmt(ctx.parsed.y) : '—'}`,
            },
          },
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

  function buildPlayerDatasets(sourceData, allPlayerList, selectedPlayers) {
    return [...selectedPlayers].map((player) => {
      const colorIdx = allPlayerList.indexOf(player);
      const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
      const data = orderedWeeks.map((w) => {
        const rows = sourceData.filter((d) => d.player === player && d.round === w.round && d.week === w.week);
        return rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.weekly_score, 0) * 100) / 100 : null;
      });
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
    const label = managerMode === 'cumulative' ? 'Cumulative Points' : 'Weekly Points';
    makeChart('trends-manager-chart', buildManagerDatasets(), label);
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
    makeChart('trends-batter-chart', buildPlayerDatasets(filtered, allBatters, selectedBatters), 'Weekly Points');
  }

  function drawPitcherChart() {
    const visible = getVisiblePitchers();
    const active = new Set([...selectedPitchers].filter((p) => visible.includes(p)));
    selectedPitchers = active;
    const filtered = pitchingData.filter((p) => mgrsForPitchers.has(p.manager));
    makeChart('trends-pitcher-chart', buildPlayerDatasets(filtered, allPitchers, selectedPitchers), 'Weekly Points');
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

  // ---- View toggle ----
  container.querySelectorAll('.trends-view-toggle .type-btn').forEach((btn) => {
    btn.onclick = () => {
      container.querySelectorAll('.trends-view-toggle .type-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
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
  document.getElementById('mode-weekly').onclick = () => {
    managerMode = 'weekly';
    document.getElementById('mode-weekly').classList.add('active');
    document.getElementById('mode-cumulative').classList.remove('active');
    drawManagerChart();
  };
  document.getElementById('mode-cumulative').onclick = () => {
    managerMode = 'cumulative';
    document.getElementById('mode-cumulative').classList.add('active');
    document.getElementById('mode-weekly').classList.remove('active');
    drawManagerChart();
  };

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

// Back-fill missing add/drop dates in roster_dates from approved swap records.
// Runs on every commissioner roster render so existing swaps (approved before this
// feature existed) also get their dates populated automatically.
function backfillRosterDatesFromSwaps(seasonData) {
  if (!seasonData || !seasonData.swaps) return false;
  let changed = false;
  for (const swap of seasonData.swaps) {
    if (swap.status !== 'approved' || !swap.week_key || !swap.swap_date || !swap.manager) continue;
    if (!seasonData.roster_dates) seasonData.roster_dates = {};
    if (!seasonData.roster_dates[swap.manager]) seasonData.roster_dates[swap.manager] = {};
    if (!seasonData.roster_dates[swap.manager][swap.week_key])
      {seasonData.roster_dates[swap.manager][swap.week_key] = {};}
    const wkDates = seasonData.roster_dates[swap.manager][swap.week_key];
    if (swap.player_out) {
      if (!wkDates[swap.player_out]) wkDates[swap.player_out] = {};
      if (!wkDates[swap.player_out].drop_date) {
        wkDates[swap.player_out].drop_date = swap.swap_date;
        changed = true;
      }
    }
    if (swap.player_in) {
      if (!wkDates[swap.player_in]) wkDates[swap.player_in] = {};
      if (!wkDates[swap.player_in].add_date) {
        wkDates[swap.player_in].add_date = swap.swap_date;
        changed = true;
      }
    }
  }
  return changed;
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

  // Build set of players explicitly added by the commissioner via swaps for Week 1
  const commAdded = new Set(
    (seasonData.swaps || [])
      .filter((s) => s.status === 'approved' && s.player_in && s.week_key === weekKey)
      .map((s) => s.player_in)
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
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    const weekRoster = mgrRoster[weekKey];
    if (weekRoster && (weekRoster[rosterKey] || []).includes(playerName)) {
      return managerName;
    }
  }
  return null;
}

// Build a lookup of "player|round|week" -> managerName from rosters + roster_dates.
// Used to attribute null-manager stats (players dropped mid-week) to the correct manager.
function buildRosterLookup(seasonData) {
  const lookup = {};
  for (const [mgr, mgrRosters] of Object.entries(seasonData.rosters || {})) {
    for (const [weekKey, weekRoster] of Object.entries(mgrRosters)) {
      (weekRoster.batters || []).forEach((p) => {
        if (!lookup[`${p}|${weekKey}`]) lookup[`${p}|${weekKey}`] = mgr;
      });
      (weekRoster.pitchers || []).forEach((p) => {
        if (!lookup[`${p}|${weekKey}`]) lookup[`${p}|${weekKey}`] = mgr;
      });
    }
  }
  for (const [mgr, mgrDates] of Object.entries(seasonData.roster_dates || {})) {
    for (const [weekKey, players] of Object.entries(mgrDates)) {
      Object.keys(players).forEach((p) => {
        if (!lookup[`${p}|${weekKey}`]) lookup[`${p}|${weekKey}`] = mgr;
      });
    }
  }
  return lookup;
}

function computeManagerScores(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  const rosterLookup = buildRosterLookup(seasonData);

  const managerMap = {};
  batting.forEach((b) => {
    const mgr = b.manager || rosterLookup[`${esc(b.batter)}|${b.round}|${b.week}`];
    if (!mgr) return;
    const weekKey = `${b.round}|${b.week}`;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.batters.includes(b.batter) && !weekRosterDates[b.batter]) return;
    if (!managerMap[mgr]) managerMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
    managerMap[mgr].batting += b.weekly_score || 0;
  });
  pitching.forEach((p) => {
    const mgr = p.manager || rosterLookup[`${esc(p.pitcher)}|${p.round}|${p.week}`];
    if (!mgr) return;
    const weekKey = `${p.round}|${p.week}`;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.pitchers.includes(p.pitcher) && !weekRosterDates[p.pitcher]) return;
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

  // Build manager-to-pool lookup
  const managerPool = {};
  managers.forEach((m) => {
    if (m.pool) managerPool[m.name] = 'Pool ' + m.pool;
  });

  const key = (r, w, m) => `${r}|${w}|${m}`;
  const map = {};

  batting.forEach((b) => {
    const mgr = b.manager || rosterLookup[`${esc(b.batter)}|${b.round}|${b.week}`];
    if (!mgr) return;
    const weekKey = `${b.round}|${b.week}`;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.batters.includes(b.batter) && !weekRosterDates[b.batter]) return;
    const k = key(b.round, b.week, mgr);
    if (!map[k])
      {map[k] = {
        round: b.round,
        week: b.week,
        manager: mgr,
        pool: managerPool[mgr] || '',
        weekly_batting: 0,
        weekly_pitching: 0,
        weekly_total: 0,
      };}
    map[k].weekly_batting += b.weekly_score || 0;
  });

  pitching.forEach((p) => {
    const mgr = p.manager || rosterLookup[`${esc(p.pitcher)}|${p.round}|${p.week}`];
    if (!mgr) return;
    const weekKey = `${p.round}|${p.week}`;
    const weekRoster = (seasonData.rosters && seasonData.rosters[mgr] && seasonData.rosters[mgr][weekKey]) || {
      batters: [],
      pitchers: [],
    };
    const weekRosterDates =
      (seasonData.roster_dates && seasonData.roster_dates[mgr] && seasonData.roster_dates[mgr][weekKey]) || {};
    if (!weekRoster.pitchers.includes(p.pitcher) && !weekRosterDates[p.pitcher]) return;
    const k = key(p.round, p.week, mgr);
    if (!map[k])
      {map[k] = {
        round: p.round,
        week: p.week,
        manager: mgr,
        pool: managerPool[mgr] || '',
        weekly_batting: 0,
        weekly_pitching: 0,
        weekly_total: 0,
      };}
    map[k].weekly_pitching += p.weekly_score || 0;
  });

  return Object.values(map).map((t) => {
    t.weekly_batting = Math.round(t.weekly_batting * 100) / 100;
    t.weekly_pitching = Math.round(t.weekly_pitching * 100) / 100;
    t.weekly_total = Math.round((t.weekly_batting + t.weekly_pitching) * 100) / 100;
    return t;
  });
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
  const managerSelect = document.getElementById('roster-manager-select');
  const titleEl = document.getElementById('roster-title');

  managerBar.style.display = 'block';

  // Inactive non-commissioner managers cannot manage rosters
  if (!isActive && !isCommissioner) {
    managerSelect.style.display = 'none';
    titleEl.textContent = loggedInMgr.name + "'s Roster";
    document.getElementById('roster-content').innerHTML =
      '<div class="card"><p style="color:var(--text-muted);">Your account is currently inactive. Contact the commissioner to be reactivated.</p></div>';
    return;
  }

  if (isCommissioner) {
    // Commissioner: show dropdown to switch between any manager's roster
    managerSelect.style.display = '';
    managerSelect.innerHTML = [...managers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => {
        const label = m.name + (m.commissioner ? ' (Commissioner)' : '') + (m.active === false ? ' (Inactive)' : '');
        return `<option value="${esc(m.name)}"${m.name === loggedInMgr.name ? ' selected' : ''}>${esc(label)}</option>`;
      })
      .join('');

    managerSelect.onchange = () => {
      const selectedName = managerSelect.value;
      titleEl.textContent = selectedName + "'s Roster";
      renderRosterData(selectedName, true);
    };
  } else {
    // Regular manager: no dropdown needed
    managerSelect.style.display = 'none';
  }

  // Show the logged-in user's roster by default
  titleEl.textContent = loggedInMgr.name + "'s Roster";
  renderRosterData(loggedInMgr.name, isCommissioner);
}

function renderRosterData(managerName, isCommissioner) {
  const container = document.getElementById('roster-content');
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  const isActive = seasonData && seasonData.status === 'active';

  // Migrate old flat rosters to per-week format if needed
  if (isActive) migrateRostersToWeekly(seasonData);

  // Compute per-period scores for this manager
  const periodScores = computeRosterPeriodScores(managerName, seasonData);

  let html = '';

  // ---- Scoring Summary Cards ----
  html += '<div class="roster-score-grid">';
  const periods = [
    { key: 'PP1', label: 'Pool Play 1' },
    { key: 'PP2', label: 'Pool Play 2' },
    { key: 'QF', label: 'Quarterfinals' },
    { key: 'SF', label: 'Semifinals' },
    { key: 'Finals', label: 'Finals' },
  ];
  periods.forEach((p) => {
    const s = periodScores[p.key];
    if (s) {
      html += `<div class="roster-score-card">
        <div class="roster-score-label">${p.label}</div>
        <div class="roster-score-value">${fmt(s.total)}</div>
        <div class="roster-score-detail">Bat: ${fmt(s.batting)} | Pit: ${fmt(s.pitching)}</div>
      </div>`;
    }
  });
  const totalBat = Object.values(periodScores).reduce((s, p) => s + p.batting, 0);
  const totalPit = Object.values(periodScores).reduce((s, p) => s + p.pitching, 0);
  const totalAll = Math.round((totalBat + totalPit) * 100) / 100;
  html += `<div class="roster-score-card roster-score-total">
    <div class="roster-score-label">Season Total</div>
    <div class="roster-score-value">${fmt(totalAll)}</div>
    <div class="roster-score-detail">Bat: ${fmt(Math.round(totalBat * 100) / 100)} | Pit: ${fmt(Math.round(totalPit * 100) / 100)}</div>
  </div>`;
  html += '</div>';

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
  // Initialize type-to-search inputs after DOM is rendered
  setupPlayerSearchInputs();
  // Initialize commissioner roster management view if present
  if (document.getElementById('comm-roster-week')) {
    window.updateCommRosterWeekView(managerName);
  }
}

// Compute cumulative scores for all players within a single scoring period (round),
// across all managers. Used for period-scoped CUM RANK computation.
function computePeriodCumulativeScores(seasonData, round) {
  const batCumulative = {},
    pitCumulative = {};
  (seasonData.weekly_batting || []).forEach((b) => {
    if (b.round !== round || !b.batter) return;
    batCumulative[b.batter] = (batCumulative[b.batter] || 0) + (b.weekly_score || 0);
  });
  (seasonData.weekly_pitching || []).forEach((p) => {
    if (p.round !== round || !p.pitcher) return;
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

  const batting = isHistorical ? DATA.batting_weekly || [] : seasonData.weekly_batting || [];
  const pitching = isHistorical ? DATA.pitching_weekly || [] : seasonData.weekly_pitching || [];

  // Per-round cache: CUM PTS = player's total in this round while on this manager's roster.
  // CUM RANK = league-wide rank within the same period.
  const roundDataCache = {};
  function getRoundData(round) {
    if (roundDataCache[round]) return roundDataCache[round];
    const sourceData = isActive ? seasonData : { weekly_batting: batting, weekly_pitching: pitching };
    // Use the season's own arrays (not DATA.batting_weekly) to avoid historical bleed.
    const cumBatting = isActive ? seasonData.weekly_batting || [] : batting;
    const cumPitching = isActive ? seasonData.weekly_pitching || [] : pitching;
    // For null-manager entries, only count them if the player was on THIS manager's roster
    // for that specific week (roster array or roster_dates entry). This lets dropped players
    // whose stats arrived post-drop count correctly while excluding other managers' unattributed stats.
    const mgrRosters = isActive ? (seasonData.rosters || {})[managerName] || {} : {};
    const mgrRosterDates = isActive ? (seasonData.roster_dates || {})[managerName] || {} : {};
    function wasRosteredThisWeek(player, weekKey, type) {
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
      const weekKey = `${b.round}|${b.week}`;
      if (!wasRosteredThisWeek(b.batter, weekKey, 'bat')) return;
      if (b.manager === managerName || b.manager === null) {
        batCum[b.batter] = (batCum[b.batter] || 0) + (b.weekly_score || 0);
      }
    });
    cumPitching.forEach((p) => {
      if (p.round !== round || !p.pitcher) return;
      const weekKey = `${p.round}|${p.week}`;
      if (!wasRosteredThisWeek(p.pitcher, weekKey, 'pit')) return;
      if (p.manager === managerName || p.manager === null) {
        pitCum[p.pitcher] = (pitCum[p.pitcher] || 0) + (p.weekly_score || 0);
      }
    });
    for (const k of Object.keys(batCum)) batCum[k] = Math.round(batCum[k] * 100) / 100;
    for (const k of Object.keys(pitCum)) pitCum[k] = Math.round(pitCum[k] * 100) / 100;
    // League-wide period cumulative for CUM RANK
    const periodScores = computePeriodCumulativeScores(sourceData, round);
    const periodRankings = computeCumulativeRankings(periodScores.batCumulative, periodScores.pitCumulative);
    roundDataCache[round] = { batCum, pitCum, periodRankings };
    return roundDataCache[round];
  }

  // Available players for commissioner add
  // Swap log and schedule dates for inline date annotations
  const approvedSwaps = isActive
    ? (seasonData.swaps || []).filter((s) => s.manager === managerName && s.status === 'approved')
    : [];
  const scheduleDates = getScheduleDates();
  // First week's start date is the season boundary: swaps recorded before this date are pre-season
  const seasonStartDate = scheduleDates && scheduleDates[0] ? scheduleDates[0].start : null;

  // Pool sets for filtering cross-pool contamination (pitcher in batter table and vice versa)
  const battersPool = isActive ? new Set(seasonData.batters_pool || []) : new Set();
  const pitchersPool = isActive ? new Set(seasonData.pitchers_pool || []) : new Set();

  // Get inline date tag for a player in a given week
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
    if (rd && rd.add_date) {
      tags.push(`Added ${fmtShortDate(rd.add_date)}`);
    } else {
      const addSwap = approvedSwaps.find((s) => s.player_in === player && s.week_key === weekKey);
      if (addSwap && addSwap.swap_date) tags.push(`Added ${fmtShortDate(addSwap.swap_date)}`);
    }
    if (rd && rd.drop_date) {
      tags.push(`Dropped ${fmtShortDate(rd.drop_date)}`);
    } else {
      const dropSwap = approvedSwaps.find((s) => s.player_out === player && s.week_key === weekKey);
      if (dropSwap && dropSwap.swap_date) tags.push(`Dropped ${fmtShortDate(dropSwap.swap_date)}`);
    }
    if (tags.length === 0) {
      return ` <span class="roster-date-tag">${fmtDateRangeShort(weekDates.start, weekDates.end)}</span>`;
    }
    return ` <span class="roster-date-tag roster-date-swap">${tags.join(' · ')}</span>`;
  }

  // For a dropped player, show the date range they were rostered (e.g. "5/4–5/6") in the
  // same grey-box style as the "not rostered" tag.  Falls back to "not rostered" only when
  // no date information is available at all.
  function notRosteredTag(player, poolType) {
    if (!isActive || !seasonData.rosters || !seasonData.rosters[managerName]) {
      return ' <span class="wrs-hist-tag">not rostered</span>';
    }

    // Prefer specific add/drop dates stored in roster_dates
    if (seasonData.roster_dates && seasonData.roster_dates[managerName]) {
      let addDate = null,
        dropDate = null;
      for (const weekDates of Object.values(seasonData.roster_dates[managerName])) {
        const entry = weekDates[player];
        if (!entry) continue;
        if (entry.add_date && (!addDate || entry.add_date < addDate)) addDate = entry.add_date;
        if (entry.drop_date && (!dropDate || entry.drop_date > dropDate)) dropDate = entry.drop_date;
      }
      if (addDate || dropDate) {
        const label =
          addDate && dropDate
            ? `${fmtSlashDate(addDate)}–${fmtSlashDate(dropDate)}`
            : addDate
              ? `from ${fmtSlashDate(addDate)}`
              : `thru ${fmtSlashDate(dropDate)}`;
        return ` <span class="wrs-hist-tag">${label}</span>`;
      }
    }

    // Fall back to week-schedule-based date range
    const mgrRoster = seasonData.rosters[managerName];
    const rosteredWeekIndices = [];
    SEASON_SCHEDULE.forEach((s, i) => {
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

  // Also include weeks where this manager has a per-week roster
  if (isActive && seasonData.rosters && seasonData.rosters[managerName]) {
    Object.keys(seasonData.rosters[managerName]).forEach((wk) => weeksWithData.add(wk));
  }

  // Build ordered list: SEASON_SCHEDULE order, most recent first
  const scheduleOrder = {};
  SEASON_SCHEDULE.forEach((s, i) => {
    scheduleOrder[`${s.round}|${s.week}`] = i;
  });
  const orderedWeeks = SEASON_SCHEDULE.map((s) => `${s.round}|${s.week}`);
  // Only show weeks that have data or rosters, plus any schedule weeks for commissioner
  const weeksToShow =
    isCommissioner && isActive
      ? orderedWeeks // show all weeks for commissioner
      : orderedWeeks.filter((wk) => weeksWithData.has(wk));

  if (weeksToShow.length === 0) return '<div class="card"><p class="text-muted">No roster data yet.</p></div>';

  // Find the latest week with data for highlighting
  let latestDataWeek = null;
  for (let i = orderedWeeks.length - 1; i >= 0; i--) {
    if (weeksWithData.has(orderedWeeks[i])) {
      latestDataWeek = orderedWeeks[i];
      break;
    }
  }

  let html = '';

  // Show weeks in chronological order, latest week with data expanded
  weeksToShow.forEach((weekKey) => {
    const [round, week] = weekKey.split('|');
    const schedEntry = SEASON_SCHEDULE.find((s) => s.round === round && s.week === week);
    const label = schedEntry ? schedEntry.label : `${round} - ${week}`;
    const weekIdx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
    const isCurrent = weekKey === latestDataWeek;

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
        ...Object.entries(weekRosterDates).filter(([, d]) => d.add_date).map(([p]) => p),
      ]);
      const wasDroppedBefore = (player) => {
        if (addedThisWeek.has(player)) return false;
        for (const [wk, players] of Object.entries(allMgrDates)) {
          if (wk === weekKey) continue;
          const pd = players[player];
          if (pd && pd.drop_date && pd.drop_date < weekStart) return true;
        }
        return false;
      };
      weekRoster = {
        batters: weekRoster.batters.filter((p) => !wasDroppedBefore(p)),
        pitchers: weekRoster.pitchers.filter((p) => !wasDroppedBefore(p)),
      };
    }
    const historicalBatters = new Set([
      ...weekRoster.batters.filter((p) => battersPool.size === 0 || battersPool.has(p)),
      ...Object.keys(weekRosterDates).filter(
        (p) =>
          (battersPool.size === 0 || battersPool.has(p)) &&
          (!seasonStartDate || !weekRosterDates[p].drop_date || weekRosterDates[p].drop_date >= seasonStartDate)
      ),
      ...approvedSwaps
        .filter(
          (s) =>
            s.player_in &&
            s.week_key === weekKey &&
            (battersPool.size === 0 || battersPool.has(s.player_in)) &&
            (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
            (weekRosterDates[s.player_in] ||
              batting.some((b) => b.batter === s.player_in && b.round === round && b.week === week))
        )
        .map((s) => s.player_in),
    ]);
    const historicalPitchers = new Set([
      ...weekRoster.pitchers.filter((p) => pitchersPool.size === 0 || pitchersPool.has(p)),
      ...Object.keys(weekRosterDates).filter(
        (p) =>
          (pitchersPool.size === 0 || pitchersPool.has(p)) &&
          (!seasonStartDate || !weekRosterDates[p].drop_date || weekRosterDates[p].drop_date >= seasonStartDate)
      ),
      ...approvedSwaps
        .filter(
          (s) =>
            s.player_in &&
            s.week_key === weekKey &&
            (pitchersPool.size === 0 || pitchersPool.has(s.player_in)) &&
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
    // Only show dropped players who actually accumulated stats during the scoring period
    const droppedBatters = [...historicalBatters].filter(
      (p) => !weekRoster.batters.includes(p) && allWeekBatting.some((b) => b.batter === p)
    );
    const droppedPitchers = [...historicalPitchers].filter(
      (p) => !weekRoster.pitchers.includes(p) && allWeekPitching.some((pt) => pt.pitcher === p)
    );

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

    // ---- Batters for this week ----
    html += `<div class="wrs-group-label">BATTERS (${weekRoster.batters.length}) <span class="wrs-group-pts">${fmt(Math.round(batTotal * 100) / 100)} pts</span></div>`;

    // Build batter stat lookup for this week
    const batStatMap = {};
    allWeekBatting.forEach((b) => {
      batStatMap[b.batter] = b;
    });

    // Pool filter: only show batting stats for players in historicalBatters (already pool-validated)
    const weekBattingForTable = allWeekBatting.filter((b) => historicalBatters.has(b.batter));
    const allBattersThisWeek = new Set([
      ...weekRoster.batters.filter((p) => battersPool.size === 0 || battersPool.has(p)),
      ...droppedBatters,
      ...weekBattingForTable.map((b) => b.batter),
    ]);
    if (allBattersThisWeek.size > 0) {
      html += '<div class="table-wrapper"><table class="data-table compact-table wrs-table"><thead><tr>';
      html +=
        '<th>Player</th><th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th>';
      html += '</tr></thead><tbody>';
      [...allBattersThisWeek]
        .sort((a, b) => ((batStatMap[b] || {}).weekly_score || 0) - ((batStatMap[a] || {}).weekly_score || 0))
        .forEach((batter) => {
          const s = batStatMap[batter] || {};
          const onRoster = weekRoster.batters.includes(batter);
          const wkRank = weekRanks.batRanks[batter];
          const { batCum, periodRankings: pRankings } = getRoundData(round);
          const cumScore = batCum[batter] || 0;
          const cumRank = pRankings.batRanks[batter];
          html += `<tr${onRoster ? '' : ' class="wrs-hist-row"'}>`;
          html += `<td>${displayPlayer(batter, seasonData)}${onRoster ? playerDateTag(batter, weekKey, weekIdx) : notRosteredTag(batter, 'batters')}</td>`;
          html += batStatCell(s, 'abs', s.abs || 0);
          html += batStatCell(s, '1b', s['1b'] || 0);
          html += batStatCell(s, '2b', s['2b'] || 0);
          html += batStatCell(s, '3b', s['3b'] || 0);
          html += batStatCell(s, 'hr', s.hr || 0);
          html += batStatCell(s, 'r', s.r || 0);
          html += batStatCell(s, 'rbi', s.rbi || 0);
          html += batStatCell(s, 'sb', s.sb || 0);
          html += batStatCell(s, 'bb', s.bb || 0);
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
    html += `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${weekRoster.pitchers.length}) <span class="wrs-group-pts">${fmt(Math.round(pitTotal * 100) / 100)} pts</span></div>`;

    const pitStatMap = {};
    allWeekPitching.forEach((p) => {
      pitStatMap[p.pitcher] = p;
    });

    const weekPitchingForTable = allWeekPitching.filter((p) => historicalPitchers.has(p.pitcher));
    const allPitchersThisWeek = new Set([
      ...weekRoster.pitchers.filter((p) => pitchersPool.size === 0 || pitchersPool.has(p)),
      ...droppedPitchers,
      ...weekPitchingForTable.map((p) => p.pitcher),
    ]);
    if (allPitchersThisWeek.size > 0) {
      html += '<div class="table-wrapper"><table class="data-table compact-table wrs-table"><thead><tr>';
      html +=
        '<th>Player</th><th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th>';
      html += '</tr></thead><tbody>';
      [...allPitchersThisWeek]
        .sort((a, b) => ((pitStatMap[b] || {}).weekly_score || 0) - ((pitStatMap[a] || {}).weekly_score || 0))
        .forEach((pitcher) => {
          const s = pitStatMap[pitcher] || {};
          const onRoster = weekRoster.pitchers.includes(pitcher);
          const wkRank = weekRanks.pitRanks[pitcher];
          const { pitCum, periodRankings: pRankingsPit } = getRoundData(round);
          const cumScore = pitCum[pitcher] || 0;
          const cumRank = pRankingsPit.pitRanks[pitcher];
          html += `<tr${onRoster ? '' : ' class="wrs-hist-row"'}>`;
          html += `<td>${displayPlayer(pitcher, seasonData)}${onRoster ? playerDateTag(pitcher, weekKey, weekIdx) : notRosteredTag(pitcher, 'pitchers')}${s.qs_highlight ? multiStartTag() : ''}</td>`;
          html += pitStatCell(s, 'gs', s.gs || 0);
          html += pitStatCell(s, 'w', s.w || 0);
          // QS: highlight yellow if pitcher had 2+ GS (qs_highlight flag)
          if (s.qs_highlight) {
            const manual = (s.manual_fields || []).includes('qs');
            html += `<td class="num qs-highlight${manual ? ' stat-manual' : ''}" title="Multiple GS this week - QS not calculated">&mdash;</td>`;
          } else {
            html += pitStatCell(s, 'qs', s.qs != null ? fmtDec(s.qs) : 0);
          }
          html += pitStatCell(s, 'cg', s.cg || 0);
          html += pitStatCell(s, 'cgso', s.cgso || 0);
          html += pitStatCell(s, 'nh', s.nh || 0);
          html += pitStatCell(s, 'ip', fmtDec(s.ip || 0));
          html += pitStatCell(s, 'h', s.h || 0);
          html += pitStatCell(s, 'er', s.er || 0);
          html += pitStatCell(s, 'bb', s.bb || 0);
          html += pitStatCell(s, 'k', s.k || 0);
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
  });

  return html;
}

// Compute per-scoring-period totals for a manager
function computeRosterPeriodScores(managerName, seasonData) {
  const result = {};

  if (DATA && DATA.team_weekly) {
    // Historical season - use pre-computed team_weekly
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

  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const countedBatting = new Set();
  const countedPitching = new Set();
  batting.forEach((b) => {
    if (b.manager !== managerName && b.manager !== null) return;
    const weekKey = `${b.round}|${b.week}`;
    const weekRoster = (seasonData.rosters &&
      seasonData.rosters[managerName] &&
      seasonData.rosters[managerName][weekKey]) || { batters: [], pitchers: [] };
    const weekRosterDates =
      (seasonData.roster_dates &&
        seasonData.roster_dates[managerName] &&
        seasonData.roster_dates[managerName][weekKey]) ||
      {};
    if (!weekRoster.batters.includes(b.batter) && !weekRosterDates[b.batter]) return;
    const key = `${esc(b.batter)}|${b.round}|${b.week}`;
    if (countedBatting.has(key)) return;
    if (!result[b.round]) result[b.round] = { batting: 0, pitching: 0, total: 0 };
    result[b.round].batting += b.weekly_score || 0;
    countedBatting.add(key);
  });
  pitching.forEach((p) => {
    if (p.manager !== managerName && p.manager !== null) return;
    const weekKey = `${p.round}|${p.week}`;
    const weekRoster = (seasonData.rosters &&
      seasonData.rosters[managerName] &&
      seasonData.rosters[managerName][weekKey]) || { batters: [], pitchers: [] };
    const weekRosterDates =
      (seasonData.roster_dates &&
        seasonData.roster_dates[managerName] &&
        seasonData.roster_dates[managerName][weekKey]) ||
      {};
    if (!weekRoster.pitchers.includes(p.pitcher) && !weekRosterDates[p.pitcher]) return;
    const key = `${esc(p.pitcher)}|${p.round}|${p.week}`;
    if (countedPitching.has(key)) return;
    if (!result[p.round]) result[p.round] = { batting: 0, pitching: 0, total: 0 };
    result[p.round].pitching += p.weekly_score || 0;
    countedPitching.add(key);
  });

  for (const data of Object.values(result)) {
    data.batting = Math.round(data.batting * 100) / 100;
    data.pitching = Math.round(data.pitching * 100) / 100;
    data.total = Math.round((data.batting + data.pitching) * 100) / 100;
  }
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
const COMMISSIONER_SWAP_REASONS = [...SWAP_REASONS, 'Commissioner Swap'];

function getSeasonSwaps(seasonData) {
  if (DATA && DATA.swaps) return DATA.swaps; // historical
  if (seasonData && seasonData.swaps) return seasonData.swaps; // active
  return [];
}

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

    // Build available (non-rostered) players from pool - union across all managers and weeks
    const rosteredBatters = new Set();
    const rosteredPitchers = new Set();
    for (const mgrRoster of Object.values(seasonData.rosters || {})) {
      for (const weekRoster of Object.values(mgrRoster)) {
        (weekRoster.batters || []).forEach((b) => rosteredBatters.add(b));
        (weekRoster.pitchers || []).forEach((p) => rosteredPitchers.add(p));
      }
    }
    const availBatters = (seasonData.batters_pool || []).filter((b) => !rosteredBatters.has(b)).sort();
    const availPitchers = (seasonData.pitchers_pool || []).filter((p) => !rosteredPitchers.has(p)).sort();

    html += `<div class="swap-form-card">
      <h3>Request a Swap</h3>
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
          <select id="swap-player-out" class="form-select">
            <option value="">Select player to swap out...</option>
            ${roster.batters
              .sort()
              .map((b) => `<option value="${b}" data-type="batter">${displayPlayer(b, seasonData)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-player-in">Player In (available)</label>
          <select id="swap-player-in" class="form-select">
            <option value="">Select replacement player...</option>
            ${availBatters.map((b) => `<option value="${b}">${displayPlayer(b, seasonData)}</option>`).join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-reason">Transaction Reason</label>
          <select id="swap-reason" class="form-select">
            <option value="">Select reason...</option>
            ${SWAP_REASONS.map((r) => `<option value="${r}">${r}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="margin-top:0.75rem;">
        <button class="btn btn-primary" onclick="submitSwapRequest('${jsStr(managerName)}')">Submit Request</button>
      </div>
      <p id="swap-form-error" class="error-text" style="display:none;margin-top:0.5rem;"></p>
      <p id="swap-form-success" class="success-text" style="display:none;margin-top:0.5rem;"></p>
    </div>`;

    // Store roster data as data attributes for the type toggle to use
    html += `<script type="application/json" id="swap-roster-data">${JSON.stringify({
      batters: roster.batters.sort(),
      pitchers: roster.pitchers.sort(),
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
                <input type="date" id="swap-drop-date-${s.id}" class="form-input swap-date-input" value="${_today}"
                  onchange="syncSwapAddDate('swap-drop-date-${s.id}','swap-add-date-${s.id}')">
              </div>
              <div class="swap-date-field">
                <label>Add Date (${esc(s.player_in)})</label>
                <input type="date" id="swap-add-date-${s.id}" class="form-input swap-date-input" value="${_tomorrow}">
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

    // Week selector
    html += `<div class="form-row" style="margin-bottom:0.75rem;">
      <label class="upload-label">Week</label>
      <select id="comm-roster-week" class="form-select" style="max-width:280px;" onchange="updateCommRosterWeekView('${safeMgr}')">`;
    SEASON_SCHEDULE.forEach((s) => {
      const wk = `${s.round}|${s.week}`;
      html += `<option value="${wk}">${s.label}</option>`;
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

  // All Swaps table (compact)
  html += `<div class="swap-list-section">
    <h3>All Swaps</h3>`;
  if (mySwaps.length > 0) {
    const sorted = [...mySwaps].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    html += '<div class="table-wrapper"><table class="data-table compact-table swap-table"><thead><tr>';
    html += '<th>Player In</th><th>Player Out</th><th>Reason</th><th>Date</th><th>Status</th>';
    html += '</tr></thead><tbody>';
    sorted.forEach((s) => {
      const status = s.status || 'approved';
      const badgeClass =
        status === 'approved'
          ? 'swap-badge-approved'
          : status === 'pending'
            ? 'swap-badge-pending'
            : 'swap-badge-denied';
      const badgeLabel = status.charAt(0).toUpperCase() + status.slice(1);
      const date = s.swap_date || (s.timestamp ? s.timestamp.split(' ')[0] : '');
      html += `<tr>`;
      html += `<td>${s.player_in ? displayPlayer(s.player_in, seasonData) : '—'}</td>`;
      html += `<td>${s.player_out ? displayPlayer(s.player_out, seasonData) : '—'}</td>`;
      html += `<td>${esc(s.reason || '')}</td>`;
      html += `<td>${date}</td>`;
      html += `<td><span class="swap-badge ${badgeClass}">${badgeLabel}</span></td>`;
      html += `</tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="text-muted">No swaps recorded.</p>';
  }
  html += '</div>';

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

    html += `<div class="card initial-submission-section" style="margin-top:1rem;">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
        <span class="swap-badge" style="background:var(--primary);color:#fff;font-size:0.8rem;">Pool Play 1</span>
        <h3 style="margin:0;">Player Submission</h3>
      </div>
      <p class="text-muted" style="margin-bottom:0.75rem;">Submit your roster for Pool Play 1: 4 batters and 3 pitchers</p>`;

    if (!poolReady && !isApproved) {
      html += `<div style="padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);margin-bottom:0.75rem;">
        <p class="text-muted" style="font-size:0.85rem;margin:0;">The player pool has not been uploaded yet. Please wait for the commissioner to upload the initial player pool files before selecting your roster.</p>
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
    } else if (poolReady) {
      // Editable submission form (only when pool is available)
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
      if (!isPending) {
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
    const periodOrder = [
      { period: 'pp2', label: 'Pool Play 2', qualCheck: true },
      { period: 'qf', label: 'Quarterfinals', qualCheck: true },
      { period: 'sf', label: 'Semifinals', qualCheck: true },
      { period: 'finals', label: 'Finals', qualCheck: true },
    ];
    for (const { period, label } of periodOrder) {
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

  let html = `<div class="card initial-submission-section" style="margin-top:1rem;">
    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
      <span class="swap-badge" style="background:var(--primary);color:#fff;font-size:0.8rem;">${periodLabel}</span>
      <h3 style="margin:0;">Player Submission</h3>
    </div>
    <p class="text-muted" style="margin-bottom:0.75rem;">Submit your roster for ${periodLabel}: 4 batters and 3 pitchers</p>`;

  if (!qualified && !isApproved) {
    html += `<div style="padding:0.75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
      <p class="text-muted" style="font-size:0.85rem;margin:0;">You have not qualified for ${periodLabel}.</p>
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
    html += `<p class="text-muted" style="font-size:0.85rem;">Waiting for commissioner to upload player pool.</p>`;
  } else if (!isOpen) {
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
    if (isPending) {
      html += `<div class="swap-badge swap-badge-pending" style="margin-bottom:0.75rem;">Pending Commissioner Approval</div>
      <p class="text-muted" style="font-size:0.82rem;margin-bottom:0.75rem;">You can still modify your roster until the commissioner approves it.</p>`;
    }
    if (deadline) {
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

    if (!isPending) {
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

  // Commissioner approval section for this period
  if (isCommissioner) {
    const allManagers = getManagers().filter((m) => m.active !== false);
    const pendingPeriod = allManagers.filter((m) => {
      const s = getPeriodSub(seasonData, period, m.name);
      return s && s.status === 'pending';
    });
    if (pendingPeriod.length > 0) {
      html += `<div class="swap-pending-card" style="margin-top:1rem;"><h4>Pending ${periodLabel} Approvals</h4>`;
      pendingPeriod.forEach((m) => {
        const s = getPeriodSub(seasonData, period, m.name);
        const safeName = jsStr(m.name);
        html += `<div class="swap-pending-item">
          <div class="swap-pending-header"><strong>${esc(m.name)}</strong><span class="swap-badge swap-badge-pending">Pending</span></div>
          <div style="padding:0.5rem 0;">
            <div style="font-size:0.82rem;"><strong>Batters:</strong> ${(s.batters || []).join(', ') || 'None'}</div>
            <div style="font-size:0.82rem;"><strong>Pitchers:</strong> ${(s.pitchers || []).join(', ') || 'None'}</div>
          </div>
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
    return t ? `${name} (${t})` : name;
  };

  if (type === 'batter') {
    batterBtn.classList.add('active');
    pitcherBtn.classList.remove('active');
    outSelect.innerHTML =
      '<option value="">Select player to swap out...</option>' +
      data.batters.map((b) => `<option value="${b}">${dp(b)}</option>`).join('');
    inSelect.innerHTML =
      '<option value="">Select replacement player...</option>' +
      data.availBatters.map((b) => `<option value="${b}">${dp(b)}</option>`).join('');
  } else {
    pitcherBtn.classList.add('active');
    batterBtn.classList.remove('active');
    outSelect.innerHTML =
      '<option value="">Select player to swap out...</option>' +
      data.pitchers.map((p) => `<option value="${p}">${dp(p)}</option>`).join('');
    inSelect.innerHTML =
      '<option value="">Select replacement player...</option>' +
      data.availPitchers.map((p) => `<option value="${p}">${dp(p)}</option>`).join('');
  }
};

// Determine which schedule round the current date falls in (or the most recent active round)
function getCurrentScheduleRound(sd) {
  const dates = sd.schedule_dates;
  if (!dates || dates.length === 0) return { round: 'PP1', weekKey: null };
  const today = fmtDateISO(new Date());
  // Find matching week
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const d = dates[i];
    if (!d) continue;
    if (today >= d.start && today <= d.end)
      {return { round: SEASON_SCHEDULE[i].round, weekKey: `${SEASON_SCHEDULE[i].round}|${SEASON_SCHEDULE[i].week}` };}
  }
  // Before first week: use PP1
  if (dates[0] && today < dates[0].start) return { round: 'PP1', weekKey: `PP1|Week 1` };
  // After last week: use Finals
  const last = SEASON_SCHEDULE[SEASON_SCHEDULE.length - 1];
  return { round: last.round, weekKey: `${last.round}|${last.week}` };
}

// Check swap limits for a manager submitting a swap request.
// Returns null if OK, or an error string if the limit is exceeded.
function checkSwapLimit(sd, managerName, reason) {
  const { round } = getCurrentScheduleRound(sd);

  // Only count approved or pending swaps (not denied) for this manager in this round
  const managerSwaps = (sd.swaps || []).filter(
    (s) => s.manager === managerName && (s.status === 'approved' || s.status === 'pending') && s.round === round
  );

  // Pool Play: unlimited Drop/IL/Trade, but only 1 Free Swap per PP-round
  if (round === 'PP1' || round === 'PP2') {
    if (reason === 'Free Swap (one per round)') {
      const used = managerSwaps.filter((s) => s.reason === 'Free Swap (one per round)').length;
      if (used >= 1)
        {return `You have already used your Free Swap for ${round === 'PP1' ? 'Pool Play 1' : 'Pool Play 2'}. You may still use Drop, IL, or Trade swaps.`;}
    }
    return null; // Drop/IL/Trade unlimited during pool play
  }

  // Playoffs (QF, SF, Finals): each type limited to 1 per round
  if (round === 'QF' || round === 'SF' || round === 'Finals') {
    const used = managerSwaps.filter((s) => s.reason === reason).length;
    if (used >= 1) {
      const roundLabel = round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : 'Finals';
      return `You have already used a "${reason}" swap during the ${roundLabel}. Each swap type may only be used once per playoff round.`;
    }
    return null;
  }

  return null;
}

// Submit a swap request
window.submitSwapRequest = function (managerName) {
  const errEl = document.getElementById('swap-form-error');
  const succEl = document.getElementById('swap-form-success');
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  const playerOut = document.getElementById('swap-player-out').value;
  const playerIn = document.getElementById('swap-player-in').value;
  const reason = document.getElementById('swap-reason').value;
  const swapDate = new Date().toISOString().split('T')[0];

  if (!playerOut || !playerIn || !reason) {
    errEl.textContent = 'All fields are required.';
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

  // Check swap limits for this round
  const limitError = checkSwapLimit(sd, managerName, reason);
  if (limitError) {
    errEl.textContent = limitError;
    errEl.style.display = 'block';
    return;
  }

  const { round, weekKey } = getCurrentScheduleRound(sd);

  const swap = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    email: LOGGED_IN_EMAIL,
    manager: managerName,
    player_out: playerOut,
    player_in: playerIn,
    reason: reason,
    swap_date: swapDate,
    round: round,
    week_key: weekKey,
    status: 'pending',
  };

  sd.swaps.push(swap);
  saveSeason(SELECTED_SEASON, sd);

  // Re-render entire roster view
  const isComm = isLoggedInCommissioner();
  renderRosterData(managerName, isComm);
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

// Commissioner: approve a swap
window.approveSwap = function (swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find((s) => s.id === swapId);
  if (!swap) return;

  // Execute the roster swap using per-week model
  if (sd.rosters && sd.rosters[swap.manager]) {
    const mgrRoster = sd.rosters[swap.manager];
    // Determine if player_out is a batter or pitcher by checking all weeks
    let playerType = null;
    for (const weekRoster of Object.values(mgrRoster)) {
      if ((weekRoster.batters || []).includes(swap.player_out)) {
        playerType = 'batters';
        break;
      }
      if ((weekRoster.pitchers || []).includes(swap.player_out)) {
        playerType = 'pitchers';
        break;
      }
    }

    if (playerType) {
      // If swap has a specific week_key, only swap in that week; otherwise swap in all weeks where player_out appears
      const weekKeys = swap.week_key ? [swap.week_key] : Object.keys(mgrRoster);
      weekKeys.forEach((wk) => {
        const weekRoster = mgrRoster[wk];
        if (!weekRoster) return;
        const arr = weekRoster[playerType] || [];
        if (arr.includes(swap.player_out)) {
          weekRoster[playerType] = arr.filter((p) => p !== swap.player_out);
          if (!weekRoster[playerType].includes(swap.player_in)) {
            weekRoster[playerType].push(swap.player_in);
          }
        }
      });
      // Auto-assign any unattributed stats for the incoming player
      assignUnclaimedStats(sd, swap.player_in, swap.manager, playerType);
    }
  }

  swap.status = 'approved';
  swap.reviewed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Read commissioner-set effective dates from the UI (fall back to today / tomorrow)
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
  const effectiveDropDate = (dropDateEl && dropDateEl.value) || _fallbackToday;
  const effectiveAddDate = (addDateEl && addDateEl.value) || _fallbackTomorrow;

  // Write add/drop dates to roster_dates so they appear in the date editor
  const rdWeekKeys = swap.week_key ? [swap.week_key] : Object.keys((sd.rosters && sd.rosters[swap.manager]) || {});
  if (!sd.roster_dates) sd.roster_dates = {};
  if (!sd.roster_dates[swap.manager]) sd.roster_dates[swap.manager] = {};
  rdWeekKeys.forEach((wk) => {
    if (!sd.roster_dates[swap.manager][wk]) sd.roster_dates[swap.manager][wk] = {};
    const wkDates = sd.roster_dates[swap.manager][wk];
    if (swap.player_out) {
      if (!wkDates[swap.player_out]) wkDates[swap.player_out] = {};
      wkDates[swap.player_out].drop_date = effectiveDropDate;
    }
    if (swap.player_in) {
      if (!wkDates[swap.player_in]) wkDates[swap.player_in] = {};
      wkDates[swap.player_in].add_date = effectiveAddDate;
    }
  });

  saveSeason(SELECTED_SEASON, sd);

  renderPendingSwapRequests();
  renderSwapLog();
  startPendingSwapPoll();

  // Find logged-in manager name and re-render
  const mgrs = getManagers();
  const mgr = mgrs.find((m) => m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase());
  if (mgr) renderRosterData(mgr.name, true);
};

// Commissioner: deny a swap
window.denySwap = function (swapId) {
  if (!confirm('Deny this swap request?')) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find((s) => s.id === swapId);
  if (!swap) return;

  swap.status = 'denied';
  swap.reviewed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveSeason(SELECTED_SEASON, sd);

  renderPendingSwapRequests();
  renderSwapLog();
  startPendingSwapPoll();

  const mgrs = getManagers();
  const mgr = mgrs.find((m) => m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase());
  if (mgr) renderRosterData(mgr.name, true);
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
          ${SWAP_REASONS.map((r) => `<option value="${r}" ${r === swap.reason ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="swap-form-field">
        <label>Swap Date</label>
        <input type="date" id="edit-date-${swapId}" class="form-select" value="${swap.swap_date || ''}">
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
window.saveSwapEdit = function (swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find((s) => s.id === swapId);
  if (!swap) return;

  const newOut = document.getElementById(`edit-out-${swapId}`).value;
  const newIn = document.getElementById(`edit-in-${swapId}`).value;
  const newReason = document.getElementById(`edit-reason-${swapId}`).value;
  const newDate = document.getElementById(`edit-date-${swapId}`).value;

  if (newOut) swap.player_out = newOut;
  if (newIn) swap.player_in = newIn;
  if (newReason) swap.reason = newReason;
  if (newDate) swap.swap_date = newDate;

  saveSeason(SELECTED_SEASON, sd);

  const mgrs = getManagers();
  const mgr = mgrs.find((m) => m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase());
  if (mgr) renderRosterData(mgr.name, true);
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

  const managers = getManagers().filter((m) => m.active);
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const allSubs = (sd && sd.initial_submissions) || {};

  const fmtDt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return (
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    );
  };

  let html = `<table class="data-table" style="width:100%;">
    <thead>
      <tr>
        <th style="text-align:left;">Manager</th>
        <th style="text-align:center;">Not Submitted</th>
        <th style="text-align:center;">Submitted</th>
        <th style="text-align:center;">Approved</th>
      </tr>
    </thead>
    <tbody>`;

  managers.forEach((m) => {
    const sub = allSubs[m.name];
    const status = sub ? sub.status : 'draft';
    const notSubmitted = !sub || status === 'draft';
    const submitted = sub && (status === 'pending' || status === 'approved');
    const approved = sub && status === 'approved';

    const notSubCell = notSubmitted
      ? `<td style="background:rgba(220,53,69,0.18);color:#dc3545;font-weight:600;text-align:center;white-space:nowrap;">Not Submitted</td>`
      : `<td style="text-align:center;color:var(--text-muted);">&#8212;</td>`;

    const subCell = submitted
      ? `<td style="background:rgba(255,193,7,0.18);color:#9a7000;font-weight:600;text-align:center;white-space:nowrap;font-size:0.82rem;">${fmtDt(sub.submitted_at) || '&#8212;'}</td>`
      : `<td style="text-align:center;color:var(--text-muted);">&#8212;</td>`;

    const appCell = approved
      ? `<td style="background:rgba(40,167,69,0.18);color:#1a7a35;font-weight:600;text-align:center;white-space:nowrap;font-size:0.82rem;">${fmtDt(sub.approved_at) || '&#8212;'}</td>`
      : `<td style="text-align:center;color:var(--text-muted);">&#8212;</td>`;

    html += `<tr>
      <td style="font-weight:500;">${esc(m.name)}</td>
      ${notSubCell}
      ${subCell}
      ${appCell}
    </tr>`;
  });

  html += '</tbody></table>';
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
  renderBannerBgSection();
  renderPendingSwapRequests();
  backfillSubmissionTimestamps();
  renderSubmissionStatusTable();
  renderSwapLog();
  renderManagersTable();
  renderPlayerPoolDisplay();
  renderWeeklyUploadSections();
  setupPlayerPoolUploads();
  setupSeasonSetupToggle();
  setupAutoFillButton();
  setupASGDateInput();
  setupPeriodDeadlineInputs();
  renderGSheetsConfig();
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

function renderSwapLog() {
  const container = document.getElementById('swap-log-list');
  if (!container) return;
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const allSwaps = sd && sd.swaps ? [...sd.swaps] : [];

  if (allSwaps.length === 0) {
    container.innerHTML = '<p class="text-muted">No swap history yet.</p>';
    return;
  }

  // Most recent first
  allSwaps.sort((a, b) => {
    const ta = a.timestamp || a.swap_date || '';
    const tb = b.timestamp || b.swap_date || '';
    return tb.localeCompare(ta);
  });

  const isCommissioner = isLoggedInCommissioner();

  const statusBadge = (s) => {
    if (s.status === 'approved') return '<span class="swap-badge swap-badge-approved">Approved</span>';
    if (s.status === 'denied') return '<span class="swap-badge swap-badge-denied">Denied</span>';
    return '<span class="swap-badge swap-badge-pending">Pending</span>';
  };

  let html =
    '<table class="data-table"><thead><tr><th>Manager</th><th>Out</th><th>In</th><th>Date</th><th>Status</th><th>Reason</th></tr></thead><tbody>';
  allSwaps.forEach((s) => {
    const date = s.timestamp ? s.timestamp.slice(0, 10) : s.swap_date || '';
    const outTxt = esc(s.player_out || '—');
    const inTxt = esc(s.player_in || '—');
    const reason = esc(s.reason || '');
    let reasonCell;
    if (isCommissioner) {
      const opts = COMMISSIONER_SWAP_REASONS.map(
        (r) => `<option value="${r}"${r === reason ? ' selected' : ''}>${r}</option>`
      ).join('');
      reasonCell = `<select onchange="saveSwapLogReason('${s.id}', this.value)" style="font-size:0.82rem;color:var(--text-muted);border:1px solid transparent;background:transparent;cursor:pointer;padding:2px 4px;border-radius:4px;" onmouseover="this.style.borderColor='var(--border)'" onmouseout="this.style.borderColor='transparent'">${opts}</select>`;
    } else {
      reasonCell = reason;
    }
    html += `<tr>
      <td>${esc(s.manager || '—')}</td>
      <td>${outTxt}</td>
      <td>${inTxt}</td>
      <td style="white-space:nowrap;font-size:0.82rem;">${date}</td>
      <td>${statusBadge(s)}</td>
      <td style="font-size:0.82rem;color:var(--text-muted);">${reasonCell}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

window.saveSwapLogReason = function (swapId, newReason) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;
  const swap = sd.swaps.find((s) => s.id === swapId);
  if (!swap) return;
  swap.reason = newReason;
  saveSeason(SELECTED_SEASON, sd);
  renderSwapLog();
};

// ---- Pending Swap Requests (Commissioner Tab) ----
function renderPendingSwapRequests() {
  const container = document.getElementById('pending-swaps-list');
  if (!container) return;

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
      isLegacy: true,
    },
    { period: 'pp2', label: 'Pool Play 2', isLegacy: false },
    { period: 'qf', label: 'Quarterfinals', isLegacy: false },
    { period: 'sf', label: 'Semifinals', isLegacy: false },
    { period: 'finals', label: 'Finals', isLegacy: false },
  ];

  for (const { period, label, isLegacy, approveFn, denyFn, editFn } of allPeriods) {
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
          <div class="swap-pending-actions">
            <button class="btn btn-sm btn-success" onclick="${approveFn}('${safeName}')">Approve</button>
            <button class="btn btn-sm btn-secondary" onclick="${editFn}('${safeName}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="${denyFn}('${safeName}')">Deny</button>
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
          <div class="swap-pending-actions">
            <button class="btn btn-sm btn-success" onclick="approvePeriodSubmission('${period}','${safeName}')">Approve</button>
            <button class="btn btn-sm btn-danger" onclick="denyPeriodSubmission('${period}','${safeName}')">Deny</button>
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
              <input type="date" id="comm-drop-date-${s.id}" class="form-input swap-date-input" value="${_today}"
                onchange="syncSwapAddDate('comm-drop-date-${s.id}','comm-add-date-${s.id}')">
            </div>
            <div class="swap-date-field">
              <label>Add Date (${esc(s.player_in || '?')})</label>
              <input type="date" id="comm-add-date-${s.id}" class="form-input swap-date-input" value="${_tomorrow}">
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
}

// Navigate to a manager's roster page from commissioner pending swaps
window.viewSwapManager = function (managerName) {
  // Switch to My Roster tab and select this manager
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
  document.querySelector('[data-tab="my-roster"]').classList.add('active');
  document.getElementById('my-roster').classList.add('active');

  const select = document.getElementById('roster-manager-select');
  if (select) {
    select.value = managerName;
    select.dispatchEvent(new Event('change'));
  }
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
        if (createStatus)
          {createStatus.innerHTML = `<p style="color:var(--success);">Season ${newYear} already exists.</p>`;}
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

      localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
      apiFetch('/api/seasons/' + newYear, {
        method: 'POST',
        body: JSON.stringify(seasons[newYear]),
      }).catch(() => {});

      if (createStatus)
        {createStatus.innerHTML = `<p style="color:var(--success);font-weight:600;">Season ${newYear} created! Switch to it using the season selector in the header.</p>`;}

      // Refresh the season selector
      buildSeasonSelector();
    };
  }

  // Reset Season button
  const resetBtn = document.getElementById('reset-season-btn');
  const resetStatus = document.getElementById('reset-season-status');
  if (resetBtn) {
    resetBtn.onclick = () => {
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

      saveSeason(SELECTED_SEASON, sd);
      if (resetStatus)
        {resetStatus.innerHTML = '<p style="color:var(--success);font-weight:600;">Season data has been reset.</p>';}
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
    saveSeason(SELECTED_SEASON, sd);

    status.innerHTML = '<span style="color:#10b981;">Schedule dates saved!</span>';
    renderScheduleDatesPreview();
    // Refresh dependent views
    renderWeeklyUploadSections();
  };
}

// Per-period defaults: earliest MLB game found on each WMMC start date for the 2026 season
// (ASG = July 14 2026 → PP1 starts May 4, PP2 June 8, QF July 20, SF Aug 3, Finals Aug 17)
const PERIOD_DEADLINE_DEFAULTS = {
  pp1: '2026-05-04T17:40', // May 4  — earliest game 5:40 PM ET (Braves/Mariners)
  pp2: '2026-06-08T18:35', // June 8 — estimated; verify against MLB schedule
  qf: '2026-07-20T19:05', // July 20 — 7:05 PM ET (Pirates @ Yankees)
  sf: '2026-08-03T20:05', // Aug 3  — 8:05 PM ET (Dodgers @ Cubs)
  finals: '2026-08-17T19:00', // Aug 17 — 7:00 PM ET (ESPN: Tigers @ Pirates)
};

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
  saveSeason(SELECTED_SEASON, sd);

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
    html += `<tr><td>${i + 1}</td><td>${s.label}</td><td>${fmtDateRangeShort(d.start, d.end)}</td></tr>`;
  });
  html += '</tbody></table>';
  preview.innerHTML = html;
}

// ---- Google Sheets Sync (Commissioner) ----
// Fully client-side: config stored in localStorage, sync calls Google Sheets API directly from browser.

function getGSheetsConfig() {
  try {
    return JSON.parse(localStorage.getItem('wmmc_gsheets_config') || '{}');
  } catch {
    return {};
  }
}

function saveGSheetsConfigLocal(config) {
  localStorage.setItem('wmmc_gsheets_config', JSON.stringify(config));
}

function extractSpreadsheetId(input) {
  if (!input) return null;
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  return null;
}

let gsheetsEditMode = false;

function renderGSheetsConfig(savedMsg) {
  const fieldsDiv = document.getElementById('gsheets-fields');
  const statusDiv = document.getElementById('gsheets-status');
  const logDiv = document.getElementById('gsheets-sync-log');
  if (!fieldsDiv) return;

  const config = getGSheetsConfig();
  const hasConfig = !!(config.spreadsheet_id && config.api_key);
  const editing = gsheetsEditMode || !hasConfig;
  const syncTime = config.sync_time || '05:00';
  const maskedKey = config.api_key ? config.api_key.slice(0, 8) + '...' + config.api_key.slice(-4) : '';
  const lockedStyle =
    'background:var(--surface-2,#f0f0f0);color:var(--text-muted,#888);cursor:default;border-color:var(--border,#ddd);';

  if (editing) {
    fieldsDiv.innerHTML = `
      <div class="form-row" style="margin-top:0.75rem;">
        <label class="upload-label">Google Sheet URL or Spreadsheet ID</label>
        <input type="text" id="gsheets-url" class="form-input"
          value="${config.spreadsheet_id || ''}"
          placeholder="https://docs.google.com/spreadsheets/d/...">
      </div>
      <div class="form-row">
        <label class="upload-label">Google API Key</label>
        <input type="text" id="gsheets-api-key" class="form-input"
          placeholder="${maskedKey ? maskedKey + ' — leave blank to keep current' : 'AIza...'}">
        <p class="upload-hint" style="margin-top:0.25rem;">Create at <em>console.cloud.google.com</em> &rarr; APIs &amp; Services &rarr; Credentials. Enable the Google Sheets API.</p>
      </div>
      <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;margin-top:0.5rem;">
        <label class="checkbox-label" style="margin:0;">
          <input type="checkbox" id="gsheets-enabled" ${config.enabled ? 'checked' : ''}> Enable daily auto-sync
        </label>
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <span style="font-size:0.85rem;white-space:nowrap;">at</span>
          <input type="time" id="gsheets-sync-time" class="form-input" value="${syncTime}" style="width:9rem;">
          <span class="upload-hint" style="margin:0;white-space:nowrap;">(server/UTC time)</span>
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="saveGSheetsConfig()">Save</button>
        ${hasConfig ? '<button class="btn btn-secondary" onclick="cancelGSheetsConfig()">Cancel</button>' : ''}
        <button class="btn btn-secondary" onclick="triggerGSheetsSync()">Sync Now</button>
      </div>`;
  } else {
    fieldsDiv.innerHTML = `
      <div style="display:grid;gap:0.5rem;margin-top:0.75rem;">
        <div class="form-row">
          <label class="upload-label">Google Sheet URL or Spreadsheet ID</label>
          <input type="text" class="form-input" value="${config.spreadsheet_id || ''}" readonly style="${lockedStyle}">
        </div>
        <div class="form-row">
          <label class="upload-label">Google API Key</label>
          <input type="text" class="form-input" value="${maskedKey}" readonly style="${lockedStyle}">
        </div>
        <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;">
          <label class="checkbox-label" style="margin:0;color:var(--text-muted,#888);">
            <input type="checkbox" ${config.enabled ? 'checked' : ''} disabled>
            ${config.enabled ? 'Auto-sync enabled' : 'Auto-sync disabled'} at ${syncTime} UTC
          </label>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="btn btn-secondary" onclick="editGSheetsConfig()">Edit</button>
          <button class="btn btn-secondary" onclick="triggerGSheetsSync()">Sync Now</button>
        </div>
      </div>`;
  }

  if (statusDiv) {
    statusDiv.innerHTML = savedMsg ? `<div class="gsheets-sync-status gsheets-sync-ok">${savedMsg}</div>` : '';
  }

  // Fetch server status: next scheduled run + full log sourced from server DB
  fetch('/api/google-sheets/sync-status')
    .then((r) => r.json())
    .then((s) => {
      if (statusDiv) {
        const nextDate = s.next_sync ? new Date(s.next_sync) : null;
        let schedHtml = '';
        if (s.enabled && nextDate) {
          schedHtml = `<div style="font-size:0.82rem;color:var(--text-muted,#666);margin-top:0.25rem;">
            Next auto-sync: ${nextDate.toLocaleString()}
          </div>`;
        } else if (!s.enabled) {
          schedHtml = `<div style="font-size:0.82rem;color:var(--text-muted,#666);margin-top:0.25rem;">
            Auto-sync is disabled — click Edit to enable it.
          </div>`;
        }
        statusDiv.innerHTML += schedHtml;
      }

      if (!logDiv) return;
      const logs = s.recent_logs || [];
      if (logs.length === 0) {
        logDiv.innerHTML = '';
        return;
      }

      let logHtml = `<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
        <h3 style="margin:0;">Sync Log</h3>
        <button class="btn btn-sm btn-secondary" onclick="const e=document.getElementById('gsheets-log-entries');e.style.display=e.style.display==='none'?'block':'none';this.textContent=this.textContent==='Show'?'Hide':'Show';" style="font-size:0.75rem;padding:0.15rem 0.5rem;">Show</button>
      </div><div id="gsheets-log-entries" style="display:none;" class="gsheets-log-list">`;
      logs.forEach((l) => {
        const autoSync = l.sync_type === 'daily';
        const ok = l.success !== false;
        const typeBadge = autoSync
          ? 'background:var(--accent,#6c63ff);color:#fff;'
          : 'background:var(--secondary,#555);color:#fff;';
        const okBadge = ok
          ? 'background:var(--success,#28a745);color:#fff;'
          : 'background:var(--danger,#dc3545);color:#fff;';
        let detail = '',
          errBlock = '';
        if (ok) {
          const errs = (l.details || []).filter((r) => r.error);
          detail = `${l.batting_imported} batting, ${l.pitching_imported} pitching records imported`;
          if (errs.length) {
            detail += ` (${errs.length} error${errs.length > 1 ? 's' : ''})`;
            errBlock = `<div style="color:var(--danger,#dc3545);font-size:0.78rem;margin-top:0.2rem;">${errs.map((r) => `Week ${r.week} ${r.type}: ${r.error}`).join('<br>')}</div>`;
          }
        } else {
          detail = `Error: ${l.error || 'Unknown error'}`;
        }
        logHtml += `<div class="gsheets-log-item">
          <span class="gsheets-log-time">${l.timestamp}</span>
          <span class="swap-badge" style="${typeBadge}font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:4px;">${autoSync ? 'Auto' : 'Manual'}</span>
          <span class="swap-badge" style="${okBadge}font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:4px;">${ok ? 'Success' : 'Failed'}</span>
          <span style="font-size:0.82rem;color:var(--text-muted,#666);">${detail}</span>
          ${errBlock}
        </div>`;
      });
      logHtml += '</div>';
      logDiv.innerHTML = logHtml;
    })
    .catch(() => {});
}

window.editGSheetsConfig = function () {
  gsheetsEditMode = true;
  renderGSheetsConfig();
};

window.cancelGSheetsConfig = function () {
  gsheetsEditMode = false;
  renderGSheetsConfig();
};

window.saveGSheetsConfig = async function () {
  const statusDiv = document.getElementById('gsheets-status');
  const urlInput = document.getElementById('gsheets-url');
  const apiKeyInput = document.getElementById('gsheets-api-key');
  const enabledCheckbox = document.getElementById('gsheets-enabled');
  const syncTimeInput = document.getElementById('gsheets-sync-time');

  const urlVal = urlInput ? urlInput.value.trim() : '';
  const spreadsheetId = extractSpreadsheetId(urlVal);
  if (urlVal && !spreadsheetId) {
    if (statusDiv)
      {statusDiv.innerHTML =
        '<div class="gsheets-sync-status gsheets-sync-err">Could not extract spreadsheet ID from the provided URL.</div>';}
    return;
  }

  const config = getGSheetsConfig();
  if (spreadsheetId) config.spreadsheet_id = spreadsheetId;
  const newKey = apiKeyInput ? apiKeyInput.value.trim() : '';
  if (newKey) config.api_key = newKey;
  config.enabled = enabledCheckbox ? enabledCheckbox.checked : config.enabled || false;
  config.season = SELECTED_SEASON;
  config.sync_time = syncTimeInput ? syncTimeInput.value || '05:00' : config.sync_time || '05:00';

  saveGSheetsConfigLocal(config);

  try {
    const resp = await apiFetch('/api/google-sheets/config', {
      method: 'POST',
      body: JSON.stringify({
        spreadsheet_url: urlVal || config.spreadsheet_id,
        api_key: config.api_key,
        enabled: config.enabled,
        season: config.season,
        sync_time: config.sync_time,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (statusDiv)
        {statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">Server error: ${err.error || resp.status}</div>`;}
      return;
    }
  } catch (e) {
    if (statusDiv)
      {statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">Could not reach server: ${e.message}</div>`;}
    return;
  }

  gsheetsEditMode = false;
  const timeLabel = config.enabled ? ` at ${config.sync_time} UTC` : '';
  renderGSheetsConfig(
    `Configuration saved. Auto-sync is <strong>${config.enabled ? 'enabled' : 'disabled'}</strong>${timeLabel}.`
  );
};

// ---- Client-side Google Sheets Sync ----

async function fetchSheetTab(spreadsheetId, tabName, apiKey) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName)}?key=${encodeURIComponent(apiKey)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404 || resp.status === 400) return null;
      if (resp.status === 429 && attempt < 2) {
        const waitSec = 65;
        const statusDiv = document.getElementById('gsheets-status');
        if (statusDiv)
          {statusDiv.innerHTML = `<p>Rate limit hit — waiting ${waitSec}s before retrying (attempt ${attempt + 2}/3)...</p>`;}
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        if (statusDiv) statusDiv.innerHTML = '<p>Syncing from Google Sheets... this may take a moment.</p>';
        continue;
      }
      const text = await resp.text();
      if (resp.status === 429)
        {throw new Error('Google Sheets API rate limit exceeded. Please wait ~60 seconds before syncing again.');}
      throw new Error(`Google Sheets API error ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.values || [];
  }
}

function parseSheetRows(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((h) => (h || '').trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = {};
    headers.forEach((h, j) => {
      row[h] = (values[i][j] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function gsFindCol(row, names) {
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === name.toLowerCase()) return row[key];
    }
  }
  return null;
}

function gsFindManagerForPlayer(sd, playerName, type) {
  if (!sd.rosters || !playerName) return null;
  const lcName = playerName.toLowerCase();
  for (const [manager, weekRosters] of Object.entries(sd.rosters)) {
    for (const roster of Object.values(weekRosters)) {
      const pool = type === 'batting' ? roster.batters || [] : roster.pitchers || [];
      if (pool.some((p) => p.toLowerCase() === lcName)) return manager;
    }
  }
  return null;
}

function gsFindManagerForPlayerWeek(sd, playerName, type, round, week) {
  if (!sd.rosters || !playerName) return null;
  const lcName = playerName.toLowerCase();
  const weekKey = `${round}|${week}`;
  for (const [manager, weekRosters] of Object.entries(sd.rosters)) {
    const roster = weekRosters[weekKey];
    if (!roster) continue;
    const pool = type === 'batting' ? roster.batters || [] : roster.pitchers || [];
    if (pool.some((p) => p.toLowerCase() === lcName)) return manager;
  }
  return null;
}

function gsProcessBattingRows(rows, sd, scheduleWeek) {
  let imported = 0,
    skipped = 0;
  rows.forEach((row) => {
    const batter = gsFindCol(row, ['batter', 'player', 'name']);
    if (!batter) return;
    let manager = gsFindManagerForPlayerWeek(sd, batter, 'batting', scheduleWeek.round, scheduleWeek.week);
    if (!manager) manager = gsFindManagerForPlayer(sd, batter, 'batting');
    if (!manager) manager = gsFindCol(row, ['manager', 'owner']);
    const isUnassigned = !manager;
    const pn = (v) => parseFloat(v) || 0;
    // Combine BB + IBB + HBP into BB
    const gsBBVal = pn(gsFindCol(row, ['bb', 'BB', 'walks']));
    const gsIBBVal = pn(gsFindCol(row, ['ibb', 'IBB']));
    const gsHBPVal = pn(gsFindCol(row, ['hbp', 'HBP']));
    const stats = {
      '1b': pn(gsFindCol(row, ['1b', '1B', 'singles'])),
      '2b': pn(gsFindCol(row, ['2b', '2B', 'doubles'])),
      '3b': pn(gsFindCol(row, ['3b', '3B', 'triples'])),
      hr: pn(gsFindCol(row, ['hr', 'HR', 'home_runs', 'homeRuns'])),
      r: pn(gsFindCol(row, ['r', 'R', 'runs'])),
      rbi: pn(gsFindCol(row, ['rbi', 'RBI'])),
      sb: pn(gsFindCol(row, ['sb', 'SB', 'stolen_bases', 'stolenBases'])),
      bb: gsBBVal + gsIBBVal + gsHBPVal,
      abs: pn(gsFindCol(row, ['ab', 'AB', 'abs', 'atBats'])),
    };
    const weeklyScore = calculateBattingScore(stats);
    const existingManual = sd.weekly_batting.find(
      (b) =>
        b.round === scheduleWeek.round &&
        b.week === scheduleWeek.week &&
        b.batter === batter &&
        b.manual_fields &&
        b.manual_fields.length > 0
    );
    if (existingManual) return;
    sd.weekly_batting = sd.weekly_batting.filter(
      (b) =>
        !(
          b.round === scheduleWeek.round &&
          b.week === scheduleWeek.week &&
          b.batter === batter &&
          b.source === 'gsheets'
        )
    );
    sd.weekly_batting.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      batter,
      status: gsFindCol(row, ['status', 'Status']) || null,
      ...stats,
      weekly_score: weeklyScore,
      total_score: weeklyScore,
      source: 'gsheets',
    });
    if (isUnassigned) skipped++;
    else imported++;
  });
  return { imported, skipped };
}

function gsProcessPitchingRows(rows, sd, scheduleWeek) {
  let imported = 0,
    skipped = 0;
  rows.forEach((row) => {
    const pitcher = gsFindCol(row, ['pitcher', 'player', 'name']);
    if (!pitcher) return;
    let manager = gsFindManagerForPlayerWeek(sd, pitcher, 'pitching', scheduleWeek.round, scheduleWeek.week);
    if (!manager) manager = gsFindManagerForPlayer(sd, pitcher, 'pitching');
    if (!manager) manager = gsFindCol(row, ['manager', 'owner']);
    const isUnassigned = !manager;
    const pn = (v) => parseFloat(v) || 0;
    // Convert IP and combine BB+IBB+HBP
    const gsRawIP = pn(gsFindCol(row, ['ip', 'IP']));
    const gsConvertedIP = convertIP(gsRawIP);
    const gsPitBBVal = pn(gsFindCol(row, ['bb', 'BB', 'walks']));
    const gsPitIBBVal = pn(gsFindCol(row, ['ibb', 'IBB']));
    const gsPitHBPVal = pn(gsFindCol(row, ['hbp', 'HBP']));
    const gsGSVal = pn(gsFindCol(row, ['gs', 'GS']));
    const gsERVal = pn(gsFindCol(row, ['er', 'ER']));
    // Calculate QS
    let gsQSVal;
    if (gsGSVal === 1 && gsConvertedIP >= 5 && gsERVal <= 2) {
      gsQSVal = 1;
    } else if (gsGSVal >= 2) {
      gsQSVal = null;
    } else {
      gsQSVal = 0;
    }
    const stats = {
      gs: gsGSVal,
      w: pn(gsFindCol(row, ['w', 'W', 'wins'])),
      qs: gsQSVal,
      qs_highlight: gsGSVal >= 2,
      cg: pn(gsFindCol(row, ['cg', 'CG'])),
      cgso: pn(gsFindCol(row, ['cgso', 'CGSO'])),
      nh: pn(gsFindCol(row, ['nh', 'NH'])),
      ip: gsConvertedIP,
      h: pn(gsFindCol(row, ['h', 'H', 'hits'])),
      er: gsERVal,
      bb: gsPitBBVal + gsPitIBBVal + gsPitHBPVal,
      k: pn(gsFindCol(row, ['k', 'K', 'so', 'SO', 'strikeouts'])),
    };
    const weeklyScore = calculatePitchingScore(stats);
    const existingManual = sd.weekly_pitching.find(
      (p) =>
        p.round === scheduleWeek.round &&
        p.week === scheduleWeek.week &&
        p.pitcher === pitcher &&
        p.manual_fields &&
        p.manual_fields.length > 0
    );
    if (existingManual) return;
    sd.weekly_pitching = sd.weekly_pitching.filter(
      (p) =>
        !(
          p.round === scheduleWeek.round &&
          p.week === scheduleWeek.week &&
          p.pitcher === pitcher &&
          p.source === 'gsheets'
        )
    );
    sd.weekly_pitching.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      pitcher,
      status: gsFindCol(row, ['status', 'Status']) || null,
      ...stats,
      weekly_score: weeklyScore,
      source: 'gsheets',
    });
    if (isUnassigned) skipped++;
    else imported++;
  });
  return { imported, skipped };
}

window.triggerGSheetsSync = async function () {
  const statusDiv = document.getElementById('gsheets-status');
  const config = getGSheetsConfig();

  if (!config.spreadsheet_id) {
    statusDiv.innerHTML =
      '<div class="gsheets-sync-status gsheets-sync-err">No spreadsheet URL configured. Save configuration first.</div>';
    return;
  }
  if (!config.api_key) {
    statusDiv.innerHTML =
      '<div class="gsheets-sync-status gsheets-sync-err">No API key configured. Save configuration first.</div>';
    return;
  }

  statusDiv.innerHTML = '<p>Syncing from Google Sheets... this may take a moment.</p>';

  try {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd) throw new Error('Season not found');
    if (!sd.weekly_batting) sd.weekly_batting = [];
    if (!sd.weekly_pitching) sd.weekly_pitching = [];

    const results = [];
    let totalBat = 0,
      totalPit = 0;

    for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
      const sched = SEASON_SCHEDULE[i];
      const weekNum = i + 1;

      try {
        const batValues = await fetchSheetTab(config.spreadsheet_id, `Week ${weekNum} Batting`, config.api_key);
        if (batValues && batValues.length > 1) {
          const r = gsProcessBattingRows(parseSheetRows(batValues), sd, sched);
          totalBat += r.imported;
          results.push({ week: weekNum, type: 'batting', imported: r.imported, skipped: r.skipped });
        }
      } catch (e) {
        results.push({ week: weekNum, type: 'batting', error: e.message });
      }

      try {
        const pitValues = await fetchSheetTab(config.spreadsheet_id, `Week ${weekNum} Pitching`, config.api_key);
        if (pitValues && pitValues.length > 1) {
          const r = gsProcessPitchingRows(parseSheetRows(pitValues), sd, sched);
          totalPit += r.imported;
          results.push({ week: weekNum, type: 'pitching', imported: r.imported, skipped: r.skipped });
        }
      } catch (e) {
        results.push({ week: weekNum, type: 'pitching', error: e.message });
      }
    }

    // Log the sync
    if (!sd.upload_log) sd.upload_log = [];
    sd.upload_log.push({
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      type: 'gsheets_sync',
      sync_type: 'manual',
      success: true,
      batting_imported: totalBat,
      pitching_imported: totalPit,
      details: results,
    });

    saveSeason(SELECTED_SEASON, sd);

    // Update config with sync status
    config.last_sync = new Date().toISOString();
    const errorCount = results.filter((r) => r.error).length;
    config.last_sync_result = {
      success: true,
      batting_imported: totalBat,
      pitching_imported: totalPit,
      weeks_with_data: results.filter((r) => !r.error && r.imported > 0).length,
      errors: errorCount,
      details: results,
    };
    saveGSheetsConfigLocal(config);

    const weeksWithData = config.last_sync_result.weeks_with_data;
    const errors = config.last_sync_result.errors;
    statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-ok">
      Sync complete! ${totalBat} batting, ${totalPit} pitching records imported.
      ${weeksWithData} weeks with data${errors > 0 ? `, ${errors} errors` : ''}.
    </div>`;

    init();
    renderGSheetsConfig();
  } catch (e) {
    const config2 = getGSheetsConfig();
    config2.last_sync = new Date().toISOString();
    config2.last_sync_result = { success: false, error: e.message };
    saveGSheetsConfigLocal(config2);

    // Log the failure
    const seasons2 = getSeasons();
    const sd2 = seasons2[SELECTED_SEASON];
    if (sd2) {
      if (!sd2.upload_log) sd2.upload_log = [];
      sd2.upload_log.push({
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        type: 'gsheets_sync',
        sync_type: 'manual',
        success: false,
        error: e.message,
      });
      saveSeason(SELECTED_SEASON, sd2);
      renderGSheetsConfig();
    }

    statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">Sync error: ${e.message}</div>`;
  }
};

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
  const poolLabel = m.pool ? 'Pool ' + m.pool : '—';
  return `<tr id="mgr-row-${idx}">
    <td><strong>${esc(m.name)}</strong></td>
    <td style="font-size:0.85rem;">${m.email}</td>
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
    <th>Name</th><th>Email</th><th>Pool</th><th></th><th>Password</th><th>Commissioner</th><th></th>
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
    mgrs.push({ name, email, commissioner: isCommissioner, active: isActive, pool });
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
  ['mgr-name', 'mgr-email'].forEach((id) => (document.getElementById(id).value = ''));
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
  mgrs[idx] = { ...mgrs[idx], name, email, commissioner: isCommissioner, active: isActive, pool };
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
  if (!existing)
    {existing = weeklyArr.find((r) => r[nameField] === playerName && !r.manager && r.round === round && r.week === week);}

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
            `<div class="player-search-item" onmousedown="selectPlayerSearchResult('${input.id}','${jsStr(m)}')">${displayPlayer(m, sd)}</div>`
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

// ---- Initial Player Submission Handlers ----
window.addInitialPlayer = function (manager, type) {
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

  if (!sd.initial_submissions) sd.initial_submissions = {};
  if (!sd.initial_submissions[manager])
    {sd.initial_submissions[manager] = { batters: [], pitchers: [], status: 'draft' };}
  const sub = sd.initial_submissions[manager];

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

  saveSeason(SELECTED_SEASON, sd);
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.removeInitialPlayer = function (manager, type, player) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];
  if (sub.status === 'approved') return;

  sub[type] = (sub[type] || []).filter((p) => p !== player);
  saveSeason(SELECTED_SEASON, sd);
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.submitInitialRoster = function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];

  if ((sub.batters || []).length !== 4 || (sub.pitchers || []).length !== 3) {
    alert('You must select exactly 4 batters and 3 pitchers.');
    return;
  }

  sub.status = 'pending';
  sub.submitted_at = new Date().toISOString();
  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.approveInitialSubmission = function (manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions || !sd.initial_submissions[manager]) return;
  const sub = sd.initial_submissions[manager];

  // Check for players already rostered by another manager
  const rosteredPlayers = {};
  for (const [mgrName, mgrRoster] of Object.entries(sd.rosters || {})) {
    if (mgrName === manager) continue;
    for (const weekRoster of Object.values(mgrRoster)) {
      (weekRoster.batters || []).forEach((b) => {
        rosteredPlayers[b] = mgrName;
      });
      (weekRoster.pitchers || []).forEach((p) => {
        rosteredPlayers[p] = mgrName;
      });
    }
  }
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

  sub.status = 'approved';
  sub.approved_at = new Date().toISOString();

  // Add all players to Week 1 roster
  const firstWeek = SEASON_SCHEDULE[0];
  const weekKey = `${firstWeek.round}|${firstWeek.week}`;
  if (!sd.rosters) sd.rosters = {};
  if (!sd.rosters[manager]) sd.rosters[manager] = {};
  if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };

  // Use the PP1 Week 1 start date as each player's add_date
  const pp1StartDate = sd.schedule_dates && sd.schedule_dates[0] ? sd.schedule_dates[0].start : null;
  if (pp1StartDate) {
    if (!sd.roster_dates) sd.roster_dates = {};
    if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
    if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
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

window.saveInitialSubmissionEdits = function (manager) {
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

  sub.batters = newBatters;
  sub.pitchers = newPitchers;
  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.denyInitialSubmission = function (manager) {
  if (!confirm(`Deny initial roster submission for ${manager}? This will reset their submission.`)) return;
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.initial_submissions) return;
  sd.initial_submissions[manager] = { batters: [], pitchers: [], status: 'draft' };
  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// ---- Period Submission Handlers (pp2 / qf / sf / finals) ----

window.addPeriodPlayer = function (period, manager, type) {
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
  saveSeason(SELECTED_SEASON, sd);
  input.value = '';
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.removePeriodPlayer = function (period, manager, type, player) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;
  sub[type] = (sub[type] || []).filter((p) => p !== player);
  saveSeason(SELECTED_SEASON, sd);
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.submitPeriodRoster = function (period, manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;
  if ((sub.batters || []).length !== 4 || (sub.pitchers || []).length !== 3) {
    alert('You must select exactly 4 batters and 3 pitchers.');
    return;
  }
  sub.status = 'pending';
  sub.submitted_at = new Date().toISOString();
  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.approvePeriodSubmission = function (period, manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;

  // Duplicate-roster check against other managers
  const rosteredByOther = {};
  for (const [mgrName, mgrRoster] of Object.entries(sd.rosters || {})) {
    if (mgrName === manager) continue;
    for (const wRoster of Object.values(mgrRoster)) {
      (wRoster.batters || []).forEach((b) => {
        rosteredByOther[b] = mgrName;
      });
      (wRoster.pitchers || []).forEach((p) => {
        rosteredByOther[p] = mgrName;
      });
    }
  }
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

  sub.status = 'approved';
  sub.approved_at = new Date().toISOString();

  // Add players to the first week of the corresponding round's roster
  const periodToRound = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };
  const roundKey = periodToRound[period];
  const firstEntry = roundKey ? SEASON_SCHEDULE.find((s) => s.round === roundKey && s.week === 'Week 1') : null;
  if (firstEntry) {
    const weekKey = `${firstEntry.round}|${firstEntry.week}`;
    const weekIdx = SEASON_SCHEDULE.indexOf(firstEntry);
    const weekStart = sd.schedule_dates && sd.schedule_dates[weekIdx] ? sd.schedule_dates[weekIdx].start : null;
    if (!sd.rosters) sd.rosters = {};
    if (!sd.rosters[manager]) sd.rosters[manager] = {};
    if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };
    if (weekStart) {
      if (!sd.roster_dates) sd.roster_dates = {};
      if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
      if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
    }
    (sub.batters || []).forEach((b) => {
      if (!sd.rosters[manager][weekKey].batters.includes(b)) sd.rosters[manager][weekKey].batters.push(b);
      if (weekStart) {
        if (!sd.roster_dates[manager][weekKey][b]) sd.roster_dates[manager][weekKey][b] = {};
        sd.roster_dates[manager][weekKey][b].add_date = weekStart;
      }
    });
    (sub.pitchers || []).forEach((p) => {
      if (!sd.rosters[manager][weekKey].pitchers.includes(p)) sd.rosters[manager][weekKey].pitchers.push(p);
      if (weekStart) {
        if (!sd.roster_dates[manager][weekKey][p]) sd.roster_dates[manager][weekKey][p] = {};
        sd.roster_dates[manager][weekKey][p].add_date = weekStart;
      }
    });
  }

  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

window.denyPeriodSubmission = function (period, manager) {
  const label = PERIOD_LABELS[period] || period;
  if (!confirm(`Deny ${label} submission for ${manager}? Their selection will be reset to draft.`)) return;
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = ensurePeriodSub(sd, period, manager);
  Object.assign(sub, { batters: [], pitchers: [], status: 'draft' });
  delete sub.submitted_at;
  delete sub.approved_at;
  saveSeason(SELECTED_SEASON, sd);
  renderPendingSwapRequests();
  renderSubmissionStatusTable();
  const isComm = isLoggedInCommissioner();
  renderRosterData(manager, isComm);
};

// Called when a manager clicks "Edit Submission" on their approved roster (before the deadline)
window.editApprovedPeriodSubmission = function (period, manager) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const sub = getPeriodSub(sd, period, manager);
  if (!sub) return;

  if (!isPeriodTimeOpen(sd, period)) {
    alert('The submission edit window has closed.');
    return;
  }

  const label = PERIOD_LABELS[period] || period;
  if (
    !confirm(
      `Editing your ${label} submission will un-approve your current roster and require commissioner re-approval.\n\n` +
        'Your current player selections will be preserved so you only need to change the players you want to swap.\n\n' +
        'Continue?'
    )
  )
    {return;}

  // Remove the approved players from the period's Week 1 roster
  const periodToRound = { pp1: 'PP1', pp2: 'PP2', qf: 'QF', sf: 'SF', finals: 'Finals' };
  const roundKey = periodToRound[period];
  const firstEntry = roundKey ? SEASON_SCHEDULE.find((s) => s.round === roundKey && s.week === 'Week 1') : null;
  if (firstEntry && sd.rosters && sd.rosters[manager]) {
    const weekKey = `${firstEntry.round}|${firstEntry.week}`;
    if (sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };
  }

  sub.status = 'draft';
  delete sub.approved_at;

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

window.saveInitialSubmissionEditsComm = function (manager) {
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

  sub.batters = newBatters;
  sub.pitchers = newPitchers;
  saveSeason(SELECTED_SEASON, sd);
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
  if (backfillRosterDatesFromSwaps(sd)) saveSeason(SELECTED_SEASON, sd);
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
  const battersPool = new Set(sd.batters_pool || []);
  const pitchersPool = new Set(sd.pitchers_pool || []);
  const commMgrRosters = (sd.rosters || {})[managerName] || {};
  const commMgrRosterDates = (sd.roster_dates || {})[managerName] || {};
  function commWasRostered(player, wkKey, type) {
    const wkRoster = commMgrRosters[wkKey] || { batters: [], pitchers: [] };
    if ((type === 'bat' ? wkRoster.batters : wkRoster.pitchers).includes(player)) return true;
    return !!(commMgrRosterDates[wkKey] || {})[player];
  }
  const commBatCum = {},
    commPitCum = {};
  (sd.weekly_batting || []).forEach((b) => {
    if (b.round !== round || !b.batter) return;
    if ((b.manager === managerName || b.manager === null) && commWasRostered(b.batter, `${b.round}|${b.week}`, 'bat')) {
      commBatCum[b.batter] = (commBatCum[b.batter] || 0) + (b.weekly_score || 0);
    }
  });
  (sd.weekly_pitching || []).forEach((p) => {
    if (p.round !== round || !p.pitcher) return;
    if (
      (p.manager === managerName || p.manager === null) &&
      commWasRostered(p.pitcher, `${p.round}|${p.week}`, 'pit')
    ) {
      commPitCum[p.pitcher] = (commPitCum[p.pitcher] || 0) + (p.weekly_score || 0);
    }
  });
  for (const k of Object.keys(commBatCum)) commBatCum[k] = Math.round(commBatCum[k] * 100) / 100;
  for (const k of Object.keys(commPitCum)) commPitCum[k] = Math.round(commPitCum[k] * 100) / 100;
  const periodScoresComm = computePeriodCumulativeScores(sd, round);
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
      ...Object.entries(rosterDates).filter(([, d]) => d.add_date).map(([p]) => p),
    ]);
    const wasDroppedBefore = (player) => {
      if (addedThisWeek.has(player)) return false;
      for (const [wk, players] of Object.entries(allMgrDates)) {
        if (wk === weekKey) continue;
        const pd = players[player];
        if (pd && pd.drop_date && pd.drop_date < weekStart) return true;
      }
      return false;
    };
    roster = {
      batters: roster.batters.filter((p) => !wasDroppedBefore(p)),
      pitchers: roster.pitchers.filter((p) => !wasDroppedBefore(p)),
    };
  }

  // Build the complete set of batters/pitchers who were on the roster at ANY point this week.
  // Sources: current roster (pool-filtered) + roster_dates (commissioner add/drop) + approved swaps.
  // Swap-added players are only included if they have actual stats or a roster_dates entry —
  // this prevents players who were dropped before any games were played from appearing.
  const historicalBatters = new Set([
    ...roster.batters.filter((p) => battersPool.size === 0 || battersPool.has(p)),
    ...Object.keys(rosterDates).filter(
      (p) =>
        (battersPool.size === 0 || battersPool.has(p)) &&
        (!seasonStartDate || !rosterDates[p].drop_date || rosterDates[p].drop_date >= seasonStartDate)
    ),
    ...approvedSwaps
      .filter(
        (s) =>
          s.player_in &&
          s.week_key === weekKey &&
          (battersPool.size === 0 || battersPool.has(s.player_in)) &&
          (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
          (rosterDates[s.player_in] ||
            batting.some((b) => b.batter === s.player_in && b.round === round && b.week === week))
      )
      .map((s) => s.player_in),
  ]);
  const historicalPitchers = new Set([
    ...roster.pitchers.filter((p) => pitchersPool.size === 0 || pitchersPool.has(p)),
    ...Object.keys(rosterDates).filter(
      (p) =>
        (pitchersPool.size === 0 || pitchersPool.has(p)) &&
        (!seasonStartDate || !rosterDates[p].drop_date || rosterDates[p].drop_date >= seasonStartDate)
    ),
    ...approvedSwaps
      .filter(
        (s) =>
          s.player_in &&
          s.week_key === weekKey &&
          (pitchersPool.size === 0 || pitchersPool.has(s.player_in)) &&
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
  // Only show dropped players who actually accumulated stats during the scoring period
  const droppedBatters = [...historicalBatters].filter(
    (p) => !roster.batters.includes(p) && allWeekBatting.some((b) => b.batter === p)
  );
  const droppedPitchers = [...historicalPitchers].filter(
    (p) => !roster.pitchers.includes(p) && allWeekPitching.some((pt) => pt.pitcher === p)
  );

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

  function commDateTag(player) {
    const dates = getPlayerDates(player);
    const weekDates = scheduleDates && scheduleDates[weekIdx] ? scheduleDates[weekIdx] : null;
    const start = dates.add_date || (weekDates ? weekDates.start : null);
    const end = dates.drop_date || (weekDates ? weekDates.end : null);
    if (!start || !end) return '';
    const hasSwap = !!(dates.add_date || dates.drop_date);
    return ` <span class="roster-date-tag${hasSwap ? ' roster-date-swap' : ''}">${fmtDateRangeShort(start, end)}</span>`;
  }

  // ---- Batters Table ----
  const batStatMap = {};
  allWeekBatting.forEach((b) => {
    batStatMap[b.batter] = b;
  });
  // Pool filter: only show batting stats for players in historicalBatters (already pool-validated)
  const weekBattingForTable = allWeekBatting.filter((b) => historicalBatters.has(b.batter));
  const allBattersThisWeek = new Set([
    ...roster.batters.filter((p) => battersPool.size === 0 || battersPool.has(p)),
    ...droppedBatters,
    ...weekBattingForTable.map((b) => b.batter),
  ]);
  // Include null-manager records for historical players (stats that arrived after a drop)
  const batTotal = allWeekBatting
    .filter((b) => historicalBatters.has(b.batter))
    .reduce((s, b) => s + (b.weekly_score || 0), 0);

  let batHtml = `<div class="wrs-group-label">BATTERS (${roster.batters.length}) <span class="wrs-group-pts">${fmt(Math.round(batTotal * 100) / 100)} pts</span></div>`;

  if (allBattersThisWeek.size > 0) {
    batHtml +=
      '<div class="table-wrapper"><table class="data-table compact-table wrs-table comm-roster-table"><thead><tr>';
    batHtml +=
      '<th>Player</th><th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th><th></th>';
    batHtml += '</tr></thead><tbody>';
    [...allBattersThisWeek]
      .sort((a, b) => ((batStatMap[b] || {}).weekly_score || 0) - ((batStatMap[a] || {}).weekly_score || 0))
      .forEach((batter) => {
        const s = batStatMap[batter] || {};
        const onRoster = roster.batters.includes(batter);
        const wkRank = weekRanks.batRanks[batter];
        const cumScore = commBatCum[batter] || 0;
        const cumRank = cumRankings.batRanks[batter];
        const safeB = jsStr(batter);
        const manual = (f) => ((s.manual_fields || []).includes(f) ? ' stat-manual' : '');
        const pDates = getPlayerDates(batter);
        const batDroppedTag =
          pDates.add_date || pDates.drop_date
            ? ` <span class="wrs-hist-tag">${pDates.add_date ? fmtSlashDate(pDates.add_date) : '?'}–${pDates.drop_date ? fmtSlashDate(pDates.drop_date) : 'now'}</span>`
            : ' <span class="wrs-hist-tag">not rostered</span>';
        batHtml += `<tr${onRoster ? '' : ' class="wrs-hist-row"'}>`;
        batHtml += `<td>${displayPlayer(batter, sd)}${onRoster ? commDateTag(batter) : batDroppedTag}</td>`;
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
        if (onRoster)
          {batHtml += `<button class="btn btn-sm btn-danger" onclick="removeFromRoster('${safeMgr}','batters','${safeB}','${weekKey}')">Drop</button> `;}
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
  const allPitchersThisWeek = new Set([
    ...roster.pitchers.filter((p) => pitchersPool.size === 0 || pitchersPool.has(p)),
    ...droppedPitchers,
    ...weekPitchingForTable.map((p) => p.pitcher),
  ]);
  // Include null-manager records for historical players (stats that arrived after a drop)
  const pitTotal = allWeekPitching
    .filter((p) => historicalPitchers.has(p.pitcher))
    .reduce((s, p) => s + (p.weekly_score || 0), 0);

  let pitHtml = `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${roster.pitchers.length}) <span class="wrs-group-pts">${fmt(Math.round(pitTotal * 100) / 100)} pts</span></div>`;

  if (allPitchersThisWeek.size > 0) {
    pitHtml +=
      '<div class="table-wrapper"><table class="data-table compact-table wrs-table comm-roster-table"><thead><tr>';
    pitHtml +=
      '<th>Player</th><th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Wk Pts</th><th>Wk Rank</th><th>Cum Pts</th><th>Cum Rank</th><th></th>';
    pitHtml += '</tr></thead><tbody>';
    [...allPitchersThisWeek]
      .sort((a, b) => ((pitStatMap[b] || {}).weekly_score || 0) - ((pitStatMap[a] || {}).weekly_score || 0))
      .forEach((pitcher) => {
        const s = pitStatMap[pitcher] || {};
        const onRoster = roster.pitchers.includes(pitcher);
        const wkRank = weekRanks.pitRanks[pitcher];
        const cumScore = commPitCum[pitcher] || 0;
        const cumRank = cumRankings.pitRanks[pitcher];
        const safeP = jsStr(pitcher);
        const manual = (f) => ((s.manual_fields || []).includes(f) ? ' stat-manual' : '');
        const pDates = getPlayerDates(pitcher);
        const pitDroppedTag =
          pDates.add_date || pDates.drop_date
            ? ` <span class="wrs-hist-tag">${pDates.add_date ? fmtSlashDate(pDates.add_date) : '?'}–${pDates.drop_date ? fmtSlashDate(pDates.drop_date) : 'now'}</span>`
            : ' <span class="wrs-hist-tag">not rostered</span>';
        pitHtml += `<tr${onRoster ? '' : ' class="wrs-hist-row"'}>`;
        pitHtml += `<td>${displayPlayer(pitcher, sd)}${onRoster ? commDateTag(pitcher) : pitDroppedTag}${s.qs_highlight ? multiStartTag() : ''}</td>`;
        pitHtml += `<td class="num${manual('gs')}">${s.gs || 0}</td>`;
        pitHtml += `<td class="num${manual('w')}">${s.w || 0}</td>`;
        if (s.qs_highlight) {
          pitHtml += `<td class="num qs-highlight" title="Multiple GS - QS not calculated">&mdash;</td>`;
        } else {
          pitHtml += `<td class="num${manual('qs')}">${s.qs != null ? fmtDec(s.qs) : 0}</td>`;
        }
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
        if (onRoster)
          {pitHtml += `<button class="btn btn-sm btn-danger" onclick="removeFromRoster('${safeMgr}','pitchers','${safeP}','${weekKey}')">Drop</button> `;}
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
      });
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

    // Store add date in roster_dates
    if (!sd.roster_dates) sd.roster_dates = {};
    if (!sd.roster_dates[manager]) sd.roster_dates[manager] = {};
    if (!sd.roster_dates[manager][weekKey]) sd.roster_dates[manager][weekKey] = {};
    if (!sd.roster_dates[manager][weekKey][player]) sd.roster_dates[manager][weekKey][player] = {};
    sd.roster_dates[manager][weekKey][player].add_date = new Date().toISOString().split('T')[0];

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
      swap_date: new Date().toISOString().split('T')[0],
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
window.hardRemoveFromRoster = function (manager, type, player, weekKey) {
  if (
    !confirm(
      `Remove ${player} and all their stats for this week from ${manager}'s roster?\n\nThis deletes their stats permanently and cannot be undone.`
    )
  )
    {return;}

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  const [round, week] = weekKey.split('|');

  // Remove from roster array
  if (sd.rosters && sd.rosters[manager] && sd.rosters[manager][weekKey] && sd.rosters[manager][weekKey][type]) {
    sd.rosters[manager][weekKey][type] = sd.rosters[manager][weekKey][type].filter((p) => p !== player);
  }

  // Remove batting stats attributed to this manager OR unattributed, for this player+week
  if (sd.weekly_batting) {
    sd.weekly_batting = sd.weekly_batting.filter(
      (b) => !(b.batter === player && b.round === round && b.week === week && (b.manager === manager || !b.manager))
    );
  }

  // Remove pitching stats attributed to this manager OR unattributed, for this player+week
  if (sd.weekly_pitching) {
    sd.weekly_pitching = sd.weekly_pitching.filter(
      (p) => !(p.pitcher === player && p.round === round && p.week === week && (p.manager === manager || !p.manager))
    );
  }

  // Remove roster_dates entry so the player doesn't reappear via the dates path
  if (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) {
    delete sd.roster_dates[manager][weekKey][player];
  }

  saveSeason(SELECTED_SEASON, sd);
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
      saveSeason(SELECTED_SEASON, sd);
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
      saveSeason(SELECTED_SEASON, sd);
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

  let html = '<div class="two-col">';
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

// ---- Weekly Stat Uploads ----

// Assign any unattributed (manager === null) weekly stats for a player to a manager.
// Called when a player is added to a roster so previously-uploaded stats are credited.
function assignUnclaimedStats(sd, playerName, managerName, rosterType) {
  const isBatter = rosterType === 'batters' || rosterType === 'batting';
  let changed = false;

  if (isBatter && sd.weekly_batting) {
    sd.weekly_batting.forEach((b) => {
      if (b.batter === playerName && !b.manager) {
        b.manager = managerName;
        changed = true;
      }
    });
  }

  if (!isBatter && sd.weekly_pitching) {
    sd.weekly_pitching.forEach((p) => {
      if (p.pitcher === playerName && !p.manager) {
        p.manager = managerName;
        changed = true;
      }
    });
  }

  return changed;
}

// Helper: find which manager owns a player via roster assignments
// Search all weeks for a player (fallback when no specific week is known)
function findManagerForPlayer(seasonData, playerName, type) {
  const rosters = seasonData.rosters || {};
  const rosterKey = type === 'batting' ? 'batters' : 'pitchers';
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    for (const weekRoster of Object.values(mgrRoster)) {
      if ((weekRoster[rosterKey] || []).includes(playerName)) {
        return managerName;
      }
    }
  }
  return null;
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

    // Advance Players button (not for the first week)
    if (hasPriorWeek) {
      const alreadyAdvanced = (sd.advanced_weeks || []).includes(i);
      html += `<div style="margin:0.5rem 0;">
        <button class="btn btn-sm btn-secondary" onclick="advancePlayers(${i})" ${alreadyAdvanced ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Advance Players</button>
        <span class="text-muted" style="font-size:0.78rem;">${alreadyAdvanced ? 'Players already advanced' : 'Copy rosters from ' + SEASON_SCHEDULE[i - 1].label}</span>
        <span id="advance-status-${i}"></span>
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
        <button class="btn btn-sm ${ppFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('PP', ${i})" ${ppFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${ppFinalized ? 'Pool Play Ended' : 'End Pool Play'}
        </button>
        ${ppFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Pool Play finalized. Managers advanced to Quarterfinals.</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize pool play and advance managers to playoffs.</span>'}
      </div>`;
    } else if (i === 11) {
      // Week 12 (QF Week 2) - End Quarterfinals
      const qfFinalized = finalized.includes('QF');
      html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm ${qfFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('QF', ${i})" ${qfFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${qfFinalized ? 'Quarterfinals Ended' : 'End Quarterfinals'}
        </button>
        ${qfFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Quarterfinals finalized.</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize quarterfinals and advance winners to semifinals.</span>'}
      </div>`;
    } else if (i === 13) {
      // Week 14 (SF Week 2) - End Semifinals
      const sfFinalized = finalized.includes('SF');
      html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm ${sfFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('SF', ${i})" ${sfFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${sfFinalized ? 'Semifinals Ended' : 'End Semifinals'}
        </button>
        ${sfFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Semifinals finalized.</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize semifinals and advance winners to finals.</span>'}
      </div>`;
    } else if (i === 15) {
      // Week 16 (Finals Week 2) - End Finals
      const finalsFinalized = finalized.includes('Finals');
      html += `<div style="margin-top:0.75rem;">
        <button class="btn btn-sm ${finalsFinalized ? 'btn-secondary' : 'btn-accent'}" onclick="finalizeRound('Finals', ${i})" ${finalsFinalized ? 'disabled style="opacity:0.5;"' : ''}>
          ${finalsFinalized ? 'Season Complete' : 'End Finals'}
        </button>
        ${finalsFinalized ? '<span class="success-text" style="font-size:0.78rem;"> Season finalized!</span>' : '<span class="text-muted" style="font-size:0.78rem;"> Finalize finals and complete the season.</span>'}
      </div>`;
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
          <span class="upload-log-time">${l.timestamp}</span>
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
      localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
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

// Advance Players: copy per-week rosters from prior week to current week for all managers.
// Creates zero-stat records for all advanced players. Marks the week as advanced to prevent re-clicking.
window.advancePlayers = function (weekIndex) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || weekIndex < 1) return;

  // Prevent double-click
  if (!sd.advanced_weeks) sd.advanced_weeks = [];
  if (sd.advanced_weeks.includes(weekIndex)) {
    const statusEl = document.getElementById(`advance-status-${weekIndex}`);
    if (statusEl)
      {statusEl.innerHTML = `<span class="text-muted" style="font-size:0.78rem;"> Players already advanced for this week.</span>`;}
    return;
  }

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
  saveSeason(SELECTED_SEASON, sd);

  const statusEl = document.getElementById(`advance-status-${weekIndex}`);
  if (statusEl) {
    statusEl.innerHTML =
      advanced > 0
        ? `<span class="success-text" style="font-size:0.78rem;"> Advanced ${advanced} manager roster${advanced > 1 ? 's' : ''}.</span>`
        : `<span class="text-muted" style="font-size:0.78rem;"> All rosters already set for this week.</span>`;
  }
  renderWeeklyUploadSections();
};

// Finalize a round (End Pool Play, End QF, End SF, End Finals)
window.finalizeRound = function (roundKey, weekIndex) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  if (!sd.finalized_rounds) sd.finalized_rounds = [];
  if (sd.finalized_rounds.includes(roundKey)) return;

  sd.finalized_rounds.push(roundKey);

  // Auto-advance players to next round if applicable
  if (roundKey === 'PP' && weekIndex < SEASON_SCHEDULE.length - 1) {
    // Advance all managers to QF Week 1 (index 10)
    window.advancePlayers(10);
  } else if (roundKey === 'QF' && weekIndex < SEASON_SCHEDULE.length - 1) {
    // Advance to SF Week 1 (index 12)
    window.advancePlayers(12);
  } else if (roundKey === 'SF' && weekIndex < SEASON_SCHEDULE.length - 1) {
    // Advance to Finals Week 1 (index 14)
    window.advancePlayers(14);
  }

  saveSeason(SELECTED_SEASON, sd);
  renderWeeklyUploadSections();
  init();
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
    if (skipped > 0)
      {statusMsg += ` ${skipped} players unrostered (stats stored, will be assigned when added to a roster).`;}
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
        qs_highlight: gsVal >= 2, // flag for yellow highlight
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
    if (skipped > 0)
      {statusMsg += ` ${skipped} players unrostered (stats stored, will be assigned when added to a roster).`;}
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

// Authoritative historical results — add a new entry each year after Finals are finalized.
const WMMC_HISTORICAL_RESULTS = [
  {
    year: '2018',
    champion: 'Cam McCallum',
    runnerUp: 'Alex Thalacker',
    third: 'Dan Kortan',
    standings: {
      'Cam McCallum': 1,
      'Alex Thalacker': 2,
      'Dan Kortan': 3,
      'Ryan Sullivan': 4,
      'Chris Bentivegna': 5,
      'Anton Capria': 6,
      'Jamie Rogers': 7,
      'Ryan Courville': 8,
      'Stephen Farmer': 9,
      'Marcus Gillespie': 10,
      'Austin Johnson': 11,
    },
  },
  {
    year: '2019',
    champion: 'Joey Auclair',
    runnerUp: 'Cam McCallum',
    third: 'Alex Thalacker',
    standings: {
      'Joey Auclair': 1,
      'Cam McCallum': 2,
      'Alex Thalacker': 3,
      'Chris Bentivegna': 4,
      'Dan Kortan': 5,
      'Ryan Sullivan': 6,
      'Jamie Rogers': 7,
      'Anton Capria': 8,
      'Austin Johnson': 9,
      'Stephen Farmer': 10,
      'Ryan Courville': 11,
      'Marcus Gillespie': 12,
    },
  },
  {
    year: '2020',
    champion: 'Ryan Sullivan',
    runnerUp: 'Dan Kortan',
    third: 'Marcus Gillespie',
    standings: {
      'Ryan Sullivan': 1,
      'Dan Kortan': 2,
      'Marcus Gillespie': 3,
      'Cam McCallum': 4,
      'Ryan Courville': 5,
      'Joey Auclair': 6,
      'Austin Johnson': 7,
      'Edgar Rivas': 8,
      'Anton Capria': 9,
      'Jamie Rogers': 10,
      'Alex Thalacker': 11,
      'Chris Bentivegna': 12,
    },
  },
  {
    year: '2021',
    champion: 'Ryan Sullivan',
    runnerUp: 'Dan Kortan',
    third: 'Joey Auclair',
    standings: {
      'Ryan Sullivan': 1,
      'Dan Kortan': 2,
      'Joey Auclair': 3,
      'Austin Johnson': 4,
      'Chris Bentivegna': 5,
      'Ryan Courville': 6,
      'Anton Capria': 7,
      'Marcus Gillespie': 8,
      'Cam McCallum': 9,
      'Jamie Rogers': 10,
      'Edgar Rivas': 11,
      'Alex Thalacker': 12,
    },
  },
  {
    year: '2022',
    champion: 'Dan Kortan',
    runnerUp: 'Alex Thalacker',
    third: 'Ryan Sullivan',
    standings: {
      'Dan Kortan': 1,
      'Alex Thalacker': 2,
      'Ryan Sullivan': 3,
      'Austin Johnson': 4,
      'Joey Auclair': 5,
      'Chris Bentivegna': 6,
      'Jamie Rogers': 7,
      'Cam McCallum': 8,
      'Edgar Rivas': 9,
      'Anton Capria': 10,
      'Marcus Gillespie': 11,
      'Ryan Courville': 12,
    },
  },
  {
    year: '2023',
    champion: 'Austin Johnson',
    runnerUp: 'Dan Kortan',
    third: 'Anton Capria',
    standings: {
      'Austin Johnson': 1,
      'Dan Kortan': 2,
      'Anton Capria': 3,
      'Cam McCallum': 4,
      'Ryan Sullivan': 5,
      'Marcus Gillespie': 6,
      'Alex Thalacker': 7,
      'Jamie Rogers': 8,
      'Joey Auclair': 9,
      'Ryan Courville': 10,
      'Chris Bentivegna': 11,
      'Edgar Rivas': 12,
    },
  },
  {
    year: '2024',
    champion: 'Dan Kortan',
    runnerUp: 'Ryan Courville',
    third: 'Jamie Rogers',
    standings: {
      'Dan Kortan': 1,
      'Ryan Courville': 2,
      'Jamie Rogers': 3,
      'Austin Johnson': 4,
      'Marcus Gillespie': 5,
      'Anton Capria': 6,
      'Cam McCallum': 7,
      'Chris Bentivegna': 8,
      'Joey Auclair': 9,
      'Ryan Sullivan': 10,
      'Alex Thalacker': 11,
      'Edgar Rivas': 12,
    },
  },
  {
    year: '2025',
    champion: 'Joey Auclair',
    runnerUp: 'Anton Capria',
    third: 'Ryan Sullivan',
    standings: {
      'Joey Auclair': 1,
      'Anton Capria': 2,
      'Ryan Sullivan': 3,
      'Cam McCallum': 4,
      'Marcus Gillespie': 5,
      'Dan Kortan': 6,
      'Jamie Rogers': 7,
      'Austin Johnson': 8,
      'Ryan Courville': 9,
      'Chris Bentivegna': 10,
      'Edgar Rivas': 11,
      'Alex Thalacker': 12,
    },
  },
];

// Number of historical seasons (2018-2025 = 8 seasons).
// Number of historical seasons (2018-2025 = 8 seasons).
// Stephen Farmer played 2018-2019 (2 seasons), Joey Auclair joined in 2019 (7 seasons),
// Edgar Rivas joined in 2020 (6 seasons). All other managers played all 8 seasons.
const WMMC_TOTAL_SEASONS_THROUGH_2025 = 8;
// Per-manager season overrides for managers who didn't play every historical season
const WMMC_SEASON_OVERRIDES = { 'Stephen Farmer': 2, 'Joey Auclair': 7, 'Edgar Rivas': 6 };

// Compute full 1-12 standings from a live season's data.
// Returns { champion, runnerUp, third, standings: { 'Name': position } } or null if not enough data.
function computeFullStandings(sd, mgrs) {
  const bat = sd.weekly_batting || [],
    pit = sd.weekly_pitching || [];
  function rs(mgr, round) {
    return (
      bat.filter((b) => b.manager === mgr && b.round === round).reduce((s, b) => s + (b.weekly_score || 0), 0) +
      pit.filter((p) => p.manager === mgr && p.round === round).reduce((s, p) => s + (p.weekly_score || 0), 0)
    );
  }

  const activeMgrs = mgrs.filter((m) => m.active !== false);
  const pools = {};
  activeMgrs.forEach((m) => {
    if (m.pool) {
      if (!pools[m.pool]) pools[m.pool] = [];
      pools[m.pool].push(m.name);
    }
  });

  const ppTotals = {};
  activeMgrs.forEach((m) => {
    ppTotals[m.name] = rs(m.name, 'PP1') + rs(m.name, 'PP2');
  });

  // Pool winners seeded first, then remaining by total PP
  const ppWinners = new Set();
  Object.values(pools).forEach((members) => {
    const byPP1 = members.slice().sort((a, b) => rs(b, 'PP1') - rs(a, 'PP1'));
    const byPP2 = members.slice().sort((a, b) => rs(b, 'PP2') - rs(a, 'PP2'));
    if (byPP1[0]) ppWinners.add(byPP1[0]);
    if (byPP2[0]) ppWinners.add(byPP2[0]);
  });

  const allNames = activeMgrs.map((m) => m.name);
  const seeded = [
    ...[...ppWinners].sort((a, b) => ppTotals[b] - ppTotals[a]),
    ...allNames.filter((n) => !ppWinners.has(n)).sort((a, b) => ppTotals[b] - ppTotals[a]),
  ].slice(0, 8);

  if (seeded.length < 8) return null;

  const nonPlayoff = allNames.filter((n) => !seeded.includes(n)).sort((a, b) => ppTotals[b] - ppTotals[a]);

  // QF: 1v8, 4v5, 3v6, 2v7
  const qfL = [];
  const qfW = [
    [seeded[0], seeded[7]],
    [seeded[3], seeded[4]],
    [seeded[2], seeded[5]],
    [seeded[1], seeded[6]],
  ].map(([a, b]) => {
    const winner = rs(a, 'QF') >= rs(b, 'QF') ? a : b;
    qfL.push(winner === a ? b : a);
    return winner;
  });

  // SF
  const sfW = [],
    sfL = [];
  [
    [qfW[0], qfW[1]],
    [qfW[2], qfW[3]],
  ].forEach(([a, b]) => {
    const winner = rs(a, 'SF') >= rs(b, 'SF') ? a : b;
    sfW.push(winner);
    sfL.push(winner === a ? b : a);
  });

  if (!sfW[0] || !sfW[1]) return null;

  // Finals + 3rd-place game (SF losers)
  const champion = rs(sfW[0], 'Finals') >= rs(sfW[1], 'Finals') ? sfW[0] : sfW[1];
  const runnerUp = champion === sfW[0] ? sfW[1] : sfW[0];
  const third = sfL.length === 2 ? (rs(sfL[0], 'Finals') >= rs(sfL[1], 'Finals') ? sfL[0] : sfL[1]) : null;
  const fourth = third ? (third === sfL[0] ? sfL[1] : sfL[0]) : null;

  const standings = {};
  standings[champion] = 1;
  if (runnerUp) standings[runnerUp] = 2;
  if (third) standings[third] = 3;
  if (fourth) standings[fourth] = 4;

  // QF losers: 5th–8th by QF score descending (highest = 5th)
  qfL
    .sort((a, b) => rs(b, 'QF') - rs(a, 'QF'))
    .forEach((n, i) => {
      standings[n] = 5 + i;
    });

  // Non-playoff: 9th–12th by total PP score descending (highest = 9th)
  nonPlayoff.forEach((n, i) => {
    standings[n] = 9 + i;
  });

  return { champion, runnerUp, third, standings };
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
  const mgrs = getManagers();
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

      // Active season with finalized Finals — compute full 1-12 standings
      if (!result && sd.finalized_rounds && sd.finalized_rounds.includes('Finals')) {
        const full = computeFullStandings(sd, mgrs);
        if (full) result = { year, ...full };
      }

      if (result) computed.push(result);
    });

  return [...WMMC_HISTORICAL_RESULTS, ...computed].sort((a, b) => Number(a.year) - Number(b.year));
}

function renderHallOfFame() {
  const container = document.getElementById('hall-of-fame-content');
  if (!container) return;

  const allResults = getHofAllResults();
  const records = buildHofRecords(allResults);
  const hasAvg = allResults.some((r) => r.standings);
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
          let round;
          if (pos <= 2) round = 'Finals';
          else if (pos <= 4) round = 'Consolation';
          else if (pos <= 8) round = 'Quarterfinals';
          else round = 'Did Not Qualify';
          return `<tr><td class="num">${posLabel}</td><td>${name}</td><td>${round}</td></tr>`;
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
  html +=
    '<p class="text-muted" style="font-size:0.85rem;margin-bottom:0.5rem;">Click a column header to sort. Position counts based on seasons with full standings data.</p>';
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
  row.style.display = row.style.display === 'none' ? '' : 'none';
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
  const records = buildHofRecords(getHofAllResults());
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
