// ============================================================
// WMMC - The Whit Merrifield Memorial Cup
// Multi-season app with Commissioner management
// ============================================================

let DATA = null;           // Data for the currently viewed season
let CURRENT_YEAR = new Date().getFullYear();
let SELECTED_SEASON = null;
let COMMISSIONER_EMAIL = null;
let ROSTER_EMAIL = null;
let LOGGED_IN_EMAIL = null;

// Google Sign-In Client ID — set this to enable Google login
const GOOGLE_CLIENT_ID = '';
const LOGIN_PASSWORD = '123';

// Scoring rubric (constant)
const SCORING = {
  batting: { '1B': 3, '2B': 5, '3B': 8, 'HR': 10, 'R': 2, 'RBI': 2, 'SB': 5, 'BB': 2 },
  pitching: { 'W': 4, 'QS': 4, 'CG': 2.5, 'CGSO': 2.5, 'NH': 5, 'IP': 2.25, 'H': -0.6, 'ER': -2, 'BB': -0.6, 'K': 2 }
};

// The schedule structure for a season (16 weeks total)
const SEASON_SCHEDULE = [
  { round: 'PP1', week: 'Week 1', label: 'Pool Play 1 - Week 1' },
  { round: 'PP1', week: 'Week 2', label: 'Pool Play 1 - Week 2' },
  { round: 'PP1', week: 'Week 3', label: 'Pool Play 1 - Week 3' },
  { round: 'PP1', week: 'Week 4', label: 'Pool Play 1 - Week 4' },
  { round: 'PP1', week: 'Week 5', label: 'Pool Play 1 - Week 5' },
  { round: 'PP2', week: 'Week 1', label: 'Pool Play 2 - Week 1' },
  { round: 'PP2', week: 'Week 2', label: 'Pool Play 2 - Week 2' },
  { round: 'PP2', week: 'Week 3', label: 'Pool Play 2 - Week 3' },
  { round: 'PP2', week: 'Week 4', label: 'Pool Play 2 - Week 4' },
  { round: 'PP2', week: 'Week 5', label: 'Pool Play 2 - Week 5' },
  { round: 'QF', week: 'Week 1', label: 'Quarterfinals - Week 1' },
  { round: 'QF', week: 'Week 2', label: 'Quarterfinals - Week 2' },
  { round: 'SF', week: 'Week 1', label: 'Semifinals - Week 1' },
  { round: 'SF', week: 'Week 2', label: 'Semifinals - Week 2' },
  { round: 'Finals', week: 'Week 1', label: 'Finals / 3rd Place - Week 1' },
  { round: 'Finals', week: 'Week 2', label: 'Finals / 3rd Place - Week 2' },
];

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

function fmtDateISO(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Short display:  "May 5 – 11" or "Jun 30 – Jul 6"
function fmtDateRangeShort(startStr, endStr) {
  const s = new Date(startStr + 'T12:00:00');
  const e = new Date(endStr + 'T12:00:00');
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (s.getMonth() === e.getMonth()) {
    return `${mo[s.getMonth()]} ${s.getDate()} – ${e.getDate()}`;
  }
  return `${mo[s.getMonth()]} ${s.getDate()} – ${mo[e.getMonth()]} ${e.getDate()}`;
}

// Get schedule_dates array for the selected season (or null)
function getScheduleDates() {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  return (sd && sd.schedule_dates) || null;
}

// Get date range string for a week index, or '' if dates not set
function weekDateLabel(weekIndex) {
  const dates = getScheduleDates();
  if (!dates || !dates[weekIndex]) return '';
  return fmtDateRangeShort(dates[weekIndex].start, dates[weekIndex].end);
}

// Look up week index from a round|week key
function weekIndexFromKey(round, week) {
  return SEASON_SCHEDULE.findIndex(s => s.round === round && s.week === week);
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
  fetch('/api/seasons/' + year, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).catch(() => {});
}
function getManagers() {
  return JSON.parse(localStorage.getItem('wmmc_managers') || '[]');
}
function saveManagers(managers) {
  localStorage.setItem('wmmc_managers', JSON.stringify(managers));
  // Persist to server in background
  fetch('/api/managers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(managers)
  }).catch(() => {});
}

// ============================================================
// Initialization
// ============================================================
async function loadData() {
  // ---- Sync from server (shared database) ----
  try {
    const [seasonsResp, managersResp] = await Promise.all([
      fetch('/api/seasons'),
      fetch('/api/managers')
    ]);
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
      fetch('/api/seasons/2025', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(seasons['2025'])
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
      commissioner: email === 'daniel.kortan@gmail.com'
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
      team_weekly: []
    };
    localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
    // Push to server
    fetch('/api/seasons/' + CURRENT_YEAR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seasons[CURRENT_YEAR])
    }).catch(() => {});
  }

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
// Authentication
// ============================================================
function findManagerByEmail(email) {
  const managers = getManagers();
  return managers.find(m => m.email && m.email.toLowerCase() === email.toLowerCase());
}

function enterApp(mgr) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('user-bar').style.display = 'flex';
  document.getElementById('user-display-name').textContent = mgr.name;

  // Auto-auth roster page
  ROSTER_EMAIL = LOGGED_IN_EMAIL;
  localStorage.setItem('wmmc_roster_email', LOGGED_IN_EMAIL);

  // Auto-auth commissioner if applicable
  if (mgr.commissioner) {
    COMMISSIONER_EMAIL = LOGGED_IN_EMAIL;
    localStorage.setItem('wmmc_commissioner_logged_in', LOGGED_IN_EMAIL);
  }

  // Show/hide commissioner nav based on role
  const commBtn = document.getElementById('commissioner-nav-btn');
  if (commBtn) {
    commBtn.style.display = mgr.commissioner ? '' : 'none';
  }

  document.getElementById('footer-year').textContent = CURRENT_YEAR;
  buildSeasonSelector();
  setupNav();
  init();
}

function handleLogin(email, password) {
  email = email.trim().toLowerCase();
  const errEl = document.getElementById('login-error-msg');

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    return;
  }

  const mgr = findManagerByEmail(email);
  if (!mgr) {
    errEl.textContent = 'Email not found. Contact the commissioner.';
    return;
  }

  if (password !== LOGIN_PASSWORD) {
    errEl.textContent = 'Incorrect password.';
    return;
  }

  errEl.textContent = '';
  LOGGED_IN_EMAIL = email;
  localStorage.setItem('wmmc_logged_in_email', email);
  enterApp(mgr);
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

function handleLogout() {
  LOGGED_IN_EMAIL = null;
  COMMISSIONER_EMAIL = null;
  ROSTER_EMAIL = null;
  localStorage.removeItem('wmmc_logged_in_email');
  localStorage.removeItem('wmmc_roster_email');
  localStorage.removeItem('wmmc_commissioner_logged_in');
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

  google.accounts.id.renderButton(
    document.getElementById('google-signin-container'),
    { theme: 'outline', size: 'large', width: '100%', text: 'signin_with' }
  );
}

function buildSeasonSelector() {
  const seasons = getSeasons();
  const select = document.getElementById('season-select');
  select.innerHTML = '';

  const years = Object.keys(seasons).sort((a, b) => b - a);
  years.forEach(year => {
    const opt = document.createElement('option');
    opt.value = year;
    const status = seasons[year].status === 'active' ? ' (Active)' : ' (Completed)';
    opt.textContent = year + status;
    select.appendChild(opt);
  });

  select.value = String(CURRENT_YEAR);
  SELECTED_SEASON = String(CURRENT_YEAR);

  select.addEventListener('change', () => {
    SELECTED_SEASON = select.value;
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
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const section = document.getElementById(btn.dataset.tab);
      if (section) section.classList.add('active');
      if (btn.dataset.tab === 'trends') renderTrends();
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
  renderStatsGrid();
  renderScoreboardContent();
}

function renderChampionBanner() {
  const banner = document.getElementById('champion-banner');
  banner.className = 'champion-banner';

  if (!DATA || !DATA.bracket || !DATA.bracket.finals) {
    banner.innerHTML = `<div class="trophy">&#127942;</div>
      <div class="champion-label">${SELECTED_SEASON} WMMC Season</div>
      <div class="champion-name">Season In Progress</div>`;
    return;
  }

  const finals = DATA.bracket.finals;
  banner.innerHTML = `
    <div class="trophy">&#127942;</div>
    <div class="champion-label">${SELECTED_SEASON} WMMC Champion</div>
    <div class="champion-name">${finals.winner}</div>
    <div class="champion-details">
      Finals: ${finals.winner} ${finals.score2} - ${finals.score1} ${finals.manager1}<br>
      Batting: ${finals.batting2} | Pitching: ${finals.pitching2}
    </div>
  `;
}

function renderStatsGrid() {
  const grid = document.getElementById('stats-grid');

  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.stats) {
    grid.innerHTML = '';
    return;
  }

  const stats = DATA.scoreboard.stats;
  const statCards = [
    { label: 'Best PP Total', value: fmt(stats.overall.best_pp_total.score), detail: stats.overall.best_pp_total.manager },
    { label: 'Best Total Batting', value: fmt(stats.overall.best_batting.score), detail: stats.overall.best_batting.manager },
    { label: 'Best Total Pitching', value: fmt(stats.overall.best_pitching.score), detail: stats.overall.best_pitching.manager },
    { label: 'Best Single Round', value: fmt(stats.overall.best_round.score), detail: stats.overall.best_round.manager },
  ];
  grid.innerHTML = statCards.map(s => `
    <div class="stat-card">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-detail">${s.detail}</div>
    </div>
  `).join('');
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

window.togglePoolPlay = function() {
  const body = document.getElementById('sb-poolplay-body');
  const btn = document.getElementById('sb-poolplay-toggle-btn');
  if (!body || !btn) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  btn.textContent = hidden ? 'Hide' : 'Show';
};

function setupScoreboardTabs() {
  const tabs = document.querySelectorAll('.sb-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sb-period').forEach(p => p.style.display = 'none');
      tab.classList.add('active');
      const target = document.getElementById('sb-' + tab.dataset.period);
      if (target) target.style.display = 'block';
    });
  });
}

// ---- Pool Play Leaders & Seeding Logic ----

function getPoolPlayLeaders() {
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.pools) {
    return { pp1Leaders: new Set(), pp2Leaders: new Set(), allLeaders: new Set(), wildcards: [], uniqueLeaderCount: 0, wildcardsNeeded: 0 };
  }

  const pools = DATA.scoreboard.pools;
  const poolPlay = DATA.scoreboard.pool_play;

  const pp1Leaders = new Set();
  const pp2Leaders = new Set();

  for (const [, members] of Object.entries(pools)) {
    const poolEntries = poolPlay.filter(p => members.includes(p.manager));

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
  const nonLeaders = [...poolPlay]
    .filter(p => !allLeaders.has(p.manager))
    .sort((a, b) => b.pp_total - a.pp_total);
  const wildcards = nonLeaders.slice(0, wildcardsNeeded).map(p => p.manager);

  return { pp1Leaders, pp2Leaders, allLeaders, wildcards, uniqueLeaderCount, wildcardsNeeded };
}

function computePlayoffSeeding(leaders) {
  if (!DATA || !DATA.scoreboard) return [];

  const poolPlay = DATA.scoreboard.pool_play;

  // Pool leaders sorted by overall PP score (highest first)
  const poolWinnerEntries = [...leaders.allLeaders]
    .map(name => poolPlay.find(p => p.manager === name))
    .filter(Boolean)
    .sort((a, b) => b.pp_total - a.pp_total);

  // Wildcards sorted by overall PP score (highest first)
  const wildcardEntries = leaders.wildcards
    .map(name => poolPlay.find(p => p.manager === name))
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

  let html = `<h3>${periodLabel} Standings</h3>`;
  html += '<div class="pool-play-grid">';

  for (const [poolName, members] of Object.entries(pools)) {
    const poolEntries = poolPlay
      .filter(p => members.includes(p.manager))
      .sort((a, b) => a[rankKey] - b[rankKey]);

    html += `<div class="pool-card">
      <h4>${poolName}</h4>
      <div class="table-wrapper">
      <table class="data-table">
        <thead><tr>
          <th>Rank</th><th>Manager</th><th>Batting</th><th>Pitching</th><th>Total</th>
        </tr></thead>
        <tbody>
          ${poolEntries.map((p, i) => `
            <tr class="${i === 0 ? 'pool-leader-row' : ''}">
              <td class="rank">${i + 1}</td>
              <td><strong>${p.manager}</strong></td>
              <td class="num">${fmt(p[battingKey])}</td>
              <td class="num">${fmt(p[pitchingKey])}</td>
              <td class="num"><strong>${fmt(p[totalKey])}</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
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
      <td><strong>${p.manager}</strong></td>
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
    seeding.forEach(s => {
      const pool = getPool(s.manager);
      let seedType = '';
      if (s.isPP1Leader && s.isPP2Leader) seedType = 'PP1 & PP2 Pool Leader';
      else if (s.isPP1Leader) seedType = 'PP1 Pool Leader';
      else if (s.isPP2Leader) seedType = 'PP2 Pool Leader';
      else seedType = 'Wildcard';

      html += `<div class="seed-item">
        <span class="seed-number">${s.seed}</span>
        <span class="seed-manager"><strong>${s.manager}</strong></span>
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
        { label: 'QF2', s1: seeding[1], s2: seeding[6] },
        { label: 'QF3', s1: seeding[2], s2: seeding[5] },
        { label: 'QF4', s1: seeding[3], s2: seeding[4] },
      ];
      matchups.forEach(m => {
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
  DATA.bracket.qf_matchups.forEach(m => {
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
  DATA.bracket.sf_matchups.forEach(m => {
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
    ${awards.map(a => `
      <div class="award-item">
        <div class="award-label">${a.label}</div>
        <div class="award-value">
          <div class="award-manager">${a.manager}</div>
          <div class="award-score">${fmt(a.score)}</div>
        </div>
      </div>
    `).join('')}
  </div>`;
}

// ---- Weekly Scores ----
function renderWeekly() {
  if (!DATA || !DATA.team_weekly) {
    document.getElementById('weekly-table').innerHTML = '<tbody><tr><td>No weekly data available for this season.</td></tr></tbody>';
    return;
  }

  const rounds = [...new Set(DATA.team_weekly.map(t => t.round))];
  const weeks = [...new Set(DATA.team_weekly.map(t => t.week))];
  const managers = [...new Set(DATA.team_weekly.map(t => t.manager))].sort();

  resetSelect('weekly-round-filter', rounds);
  resetSelect('weekly-week-filter', weeks);
  resetSelect('weekly-manager-filter', managers);

  const update = () => {
    const roundF = document.getElementById('weekly-round-filter').value;
    const weekF = document.getElementById('weekly-week-filter').value;
    const managerF = document.getElementById('weekly-manager-filter').value;

    let filtered = DATA.team_weekly;
    if (roundF !== 'all') filtered = filtered.filter(t => t.round === roundF);
    if (weekF !== 'all') filtered = filtered.filter(t => t.week === weekF);
    if (managerF !== 'all') filtered = filtered.filter(t => t.manager === managerF);

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
        ${filtered.map(t => {
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
        `}).join('')}
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
    document.getElementById('players-table').innerHTML = '<tbody><tr><td>No player data available for this season.</td></tr></tbody>';
    return;
  }

  let currentType = 'batting';

  const rounds = [...new Set(DATA.batting_weekly.map(b => b.round).concat(DATA.pitching_weekly.map(p => p.round)))].filter(Boolean);
  const weeks = [...new Set(DATA.batting_weekly.map(b => b.week).concat(DATA.pitching_weekly.map(p => p.week)))].filter(Boolean);
  const managers = [...new Set(DATA.batting_weekly.map(b => b.manager).concat(DATA.pitching_weekly.map(p => p.manager)))].filter(Boolean).sort();

  resetSelect('player-round-filter', rounds);
  resetSelect('player-week-filter', weeks);
  resetSelect('player-manager-filter', managers);

  const typeBtns = document.querySelectorAll('.type-btn');
  typeBtns.forEach(btn => {
    if (btn.id && btn.id.startsWith('manual-')) return; // Skip manual update buttons
    btn.onclick = () => {
      typeBtns.forEach(b => {
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
      if (roundF !== 'all') filtered = filtered.filter(b => b.round === roundF);
      if (weekF !== 'all') filtered = filtered.filter(b => b.week === weekF);
      if (managerF !== 'all') filtered = filtered.filter(b => b.manager === managerF);

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
          ${filtered.map(b => {
            const wi = weekIndexFromKey(b.round, b.week);
            const dateStr = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
            return `
            <tr>
              <td>${b.week || ''}</td>
              ${dates ? `<td class="week-dates">${dateStr}</td>` : ''}
              <td><strong>${b.manager}</strong></td>
              <td>${b.batter}</td>
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
          `}).join('')}
        </tbody>
      `;
    } else {
      let filtered = DATA.pitching_weekly;
      if (roundF !== 'all') filtered = filtered.filter(p => p.round === roundF);
      if (weekF !== 'all') filtered = filtered.filter(p => p.week === weekF);
      if (managerF !== 'all') filtered = filtered.filter(p => p.manager === managerF);

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
          ${filtered.map(p => {
            const wi = weekIndexFromKey(p.round, p.week);
            const dateStr = dates && wi >= 0 ? fmtDateRangeShort(dates[wi].start, dates[wi].end) : '';
            return `
            <tr>
              <td>${p.week || ''}</td>
              ${dates ? `<td class="week-dates">${dateStr}</td>` : ''}
              <td><strong>${p.manager}</strong></td>
              <td>${p.pitcher}</td>
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
          `}).join('')}
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
          ${(b.qf_matchups || []).map(m => matchupHTML(m, true)).join('')}
        </div>
        <div class="bracket-round" style="margin-top: 3rem;">
          <h3>Semifinals</h3>
          ${(b.sf_matchups || []).map(m => matchupHTML(m, true)).join('')}
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
  { text: 'The Whit Merrifield Memorial Cup is a fantasy baseball game that uses limited rosters and daily fantasy scoring to be played in conjunction with the season-long rotisserie League. The game will consist of a subset of a Franchise\'s rotisserie League players competing in a Cup format of round robin play followed by an elimination tournament.' },
  { heading: true, text: 'Format' },
  { text: 'The WMMC will start 10 weeks prior to the All-Star Break. Franchises will be organized into pools based on prior year\'s finishing position.' },
  { text: 'Franchises will be first categorized into Pots based on prior year\'s finishing position: Pot 1 (1st\u20133rd place), Pot 2 (4th\u20136th), Pot 3 (7th\u20139th), Pot 4 (10th\u201312th). The three players in Pot 1 draft their pools in snake order.' },
  { heading: true, text: 'Player Selection' },
  { text: 'Owners will select 4 batters and 3 starting pitchers that will accumulate points for the current round.' },
  { text: 'At the conclusion of each round, players can be swapped in or out.' },
  { text: 'If a player is traded or dropped from an owner\'s team, they must be replaced in WMMC.' },
  { text: 'Injured players can be replaced if they receive an official IL designation, but cannot be subbed back in until the next round unless they are used to replace another dropped/traded/injured player.' },
  { text: 'Each owner is allowed one free player swap per round, in addition to normal status change swaps.' },
  { text: 'For playoff rounds, owners are restricted to one drop swap per round.' },
  { text: 'There are no limits on the number of times a player can be selected.' },
  { text: 'All replacement player requests must be filed to the Commissioner\'s office and confirmed by the Commissioner.' },
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
  { text: 'Pool Play Advancement Rules: The winners of PP1 and PP2 per pool automatically advance to the Quarterfinals (up to 6 teams). Top 2 high-scoring non-PP winners are automatically selected as Wildcards. If a pool\'s PP1 champion is also PP2 champion, the next highest overall scoring team from any pool is selected.' },
  { heading: true, text: 'Elimination Play' },
  { text: 'After pool play finishes, Owners will be seeded: Pool Play Winners by overall score, then Wildcards by overall score.' },
  { text: 'There will be three rounds of two-week single-elimination games: Quarterfinals, Semifinals, and Finals.' },
  { text: 'Bracket: 1st vs 8th (QF1), 4th vs 5th (QF2), 3rd vs 6th (QF3), 2nd vs 7th (QF4). QF1 winner vs QF2 winner (SF1), QF3 winner vs QF4 winner (SF2). SF1 winner vs SF2 winner (Final), SF1 loser vs SF2 loser (3rd place).' },
  { text: 'The bracket will not reseed after each round. Owners use the same lineup/replacement rules during playoffs.' },
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
  if (!seasonData) { container.innerHTML = ''; return; }

  const isActive = seasonData.status === 'active';
  const dates = isActive ? getScheduleDates() : (seasonData.schedule_dates || null);
  const uploadedWeeks = new Set();
  if (isActive) {
    (seasonData.weekly_batting || []).forEach(b => uploadedWeeks.add(`${b.round}|${b.week}`));
  } else if (seasonData.data && seasonData.data.team_weekly) {
    seasonData.data.team_weekly.forEach(t => uploadedWeeks.add(`${t.round}|${t.week}`));
  }

  let html = `<div class="card"><h2>${SELECTED_SEASON} Season Schedule</h2>`;
  html += '<div class="schedule-timeline">';
  let prevRound = '';
  SEASON_SCHEDULE.forEach((s, i) => {
    const weekKey = `${s.round}|${s.week}`;
    const hasData = uploadedWeeks.has(weekKey);
    const dateStr = dates && dates[i] ? fmtDateRangeShort(dates[i].start, dates[i].end) : '';
    const statusClass = hasData ? 'tl-done' : (isActive ? 'tl-pending' : 'tl-empty');

    // Round separator
    if (s.round !== prevRound) {
      const roundLabels = { PP1: 'Pool Play 1', PP2: 'Pool Play 2', QF: 'Quarterfinals', SF: 'Semifinals', Finals: 'Finals' };
      html += `<div class="tl-round-label">${roundLabels[s.round] || s.round}</div>`;
      prevRound = s.round;
    }

    html += `<div class="tl-item ${statusClass}">
      <div class="tl-marker"></div>
      <div class="tl-content">
        <span class="tl-week">${s.week}</span>
        ${dateStr ? `<span class="tl-dates">${dateStr}</span>` : ''}
        <span class="tl-status">${hasData ? 'Complete' : (isActive ? 'Pending' : '')}</span>
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
  const isCommissioner = !!(COMMISSIONER_EMAIL || (LOGGED_IN_EMAIL && getManagers().some(m => m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase() && m.commissioner)));

  // Use season-level overrides if they exist, otherwise use defaults
  const batScoring = (sd && sd.custom_batting_scoring) || SCORING.batting;
  const pitScoring = (sd && sd.custom_pitching_scoring) || SCORING.pitching;

  let html = `<div class="card">
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
              ${Object.entries(batScoring).map(([k, v]) =>
                `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`
              ).join('')}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Pitching</h3>
          <table class="data-table scoring-table">
            <thead><tr><th>Category</th><th>Points</th></tr></thead>
            <tbody>
              ${Object.entries(pitScoring).map(([k, v]) =>
                `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`
              ).join('')}
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
  const isCommissioner = !!(COMMISSIONER_EMAIL || (LOGGED_IN_EMAIL && getManagers().some(m => m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase() && m.commissioner)));

  // Use season-level custom rules if they exist, or historical rules_text, or defaults
  let rules;
  if (sd && sd.custom_rules) {
    rules = sd.custom_rules;
  } else if (DATA && DATA.rules_text) {
    // Convert old format to new format
    const headings = ['Purpose', 'Format', 'Player Selection', 'Schedule', 'Pool Play', 'Elimination Play', 'Scoring'];
    rules = DATA.rules_text
      .filter(line => line !== 'The Whit Merrifield Memorial Cup')
      .map(line => headings.includes(line) ? { heading: true, text: line } : { text: line });
  } else {
    rules = WMMC_DEFAULT_RULES;
  }

  let rulesHtml = '';
  rules.forEach(r => {
    if (r.heading) {
      rulesHtml += `<p class="rule-heading">${r.text}</p>`;
    } else {
      rulesHtml += `<p>${r.text}</p>`;
    }
  });

  let html = `<div class="card">
    <div class="league-section-header">
      <h2>Constitution & Rules</h2>
      ${isCommissioner ? '<button class="btn btn-sm btn-outline" onclick="editLeagueRules()">Edit</button>' : ''}
    </div>
    <div id="league-rules-display">${rulesHtml}</div>
  </div>`;

  container.innerHTML = html;
}

// Commissioner: edit scoring values
window.editLeagueScoring = function() {
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

window.saveLeagueScoring = function() {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const batScoring = {};
  Object.keys(SCORING.batting).forEach(k => {
    batScoring[k] = parseFloat(document.getElementById(`se-bat-${k}`).value) || 0;
  });
  const pitScoring = {};
  Object.keys(SCORING.pitching).forEach(k => {
    pitScoring[k] = parseFloat(document.getElementById(`se-pit-${k}`).value) || 0;
  });

  sd.custom_batting_scoring = batScoring;
  sd.custom_pitching_scoring = pitScoring;
  saveSeason(SELECTED_SEASON, sd);
  renderLeagueScoring();
};

// Commissioner: edit constitution/rules
window.editLeagueRules = function() {
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
      .filter(line => line !== 'The Whit Merrifield Memorial Cup')
      .map(line => headings.includes(line) ? { heading: true, text: line } : { text: line });
  } else {
    rules = WMMC_DEFAULT_RULES;
  }

  // Convert to editable text: headings prefixed with ##
  const textLines = rules.map(r => r.heading ? `## ${r.text}` : r.text).join('\n');

  container.innerHTML = `<div>
    <p class="text-muted" style="font-size:0.78rem;margin-bottom:0.5rem;">Lines starting with <strong>##</strong> will be rendered as section headings. All other lines are paragraphs.</p>
    <textarea id="league-rules-editor" class="league-rules-textarea">${textLines}</textarea>
    <div class="stat-edit-actions" style="margin-top:0.5rem;">
      <button class="btn btn-primary" onclick="saveLeagueRules()">Save Rules</button>
      <button class="btn btn-secondary" onclick="renderLeagueRules()">Cancel</button>
    </div>
  </div>`;
};

window.saveLeagueRules = function() {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const text = document.getElementById('league-rules-editor').value;
  const lines = text.split('\n').filter(l => l.trim());
  sd.custom_rules = lines.map(l => {
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
  // Repair any data where manager was incorrectly set to MLB team abbreviation
  if (repairManagerAssignments(seasonData)) {
    saveSeason(SELECTED_SEASON, seasonData);
  }

  const banner = document.getElementById('champion-banner');
  banner.className = 'champion-banner banner-compact';
  banner.innerHTML = `
    <div class="champion-label"><span class="trophy">&#9918;</span> ${SELECTED_SEASON} WMMC Season</div>
    <div class="champion-name">Season Active</div>
    <div class="champion-details">Upload weekly stats via Commissioner page to track scores.</div>
  `;

  const grid = document.getElementById('stats-grid');
  const managers = getManagers();
  const managerScores = computeManagerScores(seasonData);

  if (managerScores.length > 0) {
    const sorted = [...managerScores].sort((a, b) => b.total - a.total);
    const top = sorted[0];
    const bestBat = [...managerScores].sort((a, b) => b.batting - a.batting)[0];
    const bestPitch = [...managerScores].sort((a, b) => b.pitching - a.pitching)[0];

    grid.innerHTML = [
      { label: 'Current Leader', value: fmt(top.total), detail: top.manager },
      { label: 'Best Batting', value: fmt(bestBat.batting), detail: bestBat.manager },
      { label: 'Best Pitching', value: fmt(bestPitch.pitching), detail: bestPitch.manager },
    ].map(s => `
      <div class="stat-card">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value">${s.value}</div>
        <div class="stat-detail">${s.detail}</div>
      </div>
    `).join('');
  } else {
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Managers</div>
        <div class="stat-value">${managers.length}</div>
        <div class="stat-detail">Registered</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Batters Pool</div>
        <div class="stat-value">${(seasonData.batters_pool || []).length}</div>
        <div class="stat-detail">Available</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pitchers Pool</div>
        <div class="stat-value">${(seasonData.pitchers_pool || []).length}</div>
        <div class="stat-detail">Available</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Weeks Uploaded</div>
        <div class="stat-value">${countUploadedWeeks(seasonData)}</div>
        <div class="stat-detail">of 16</div>
      </div>
    `;
  }

  // Scoreboard content for active season
  const scoreboardContent = document.getElementById('scoreboard-content');
  if (managerScores.length > 0 || managers.some(m => m.pool)) {
    scoreboardContent.innerHTML = renderActiveScoreboardTabs(seasonData, managerScores, managers);
    setupScoreboardTabs();
  } else {
    // Determine why there are no scores
    const hasUploadedData = (seasonData.weekly_batting || []).length + (seasonData.weekly_pitching || []).length > 0;
    const hasRosters = Object.keys(seasonData.rosters || {}).some(k => {
      const r = seasonData.rosters[k];
      return (r.batters || []).length > 0 || (r.pitchers || []).length > 0;
    });
    let msg = 'No scoring data yet. Upload weekly stats via the Commissioner page to track scores.';
    if (hasUploadedData && !hasRosters) {
      msg = 'Player stat data has been uploaded, but no players are assigned to manager rosters yet. ' +
            'Log in as Commissioner on the My Roster page to assign players — scores will appear once rosters are configured.';
    } else if (hasUploadedData && hasRosters) {
      msg = 'Player stat data has been uploaded and rosters are configured, but no uploaded players match any roster assignment. ' +
            'Check that player names in the uploaded CSV match exactly the names in each manager\'s roster.';
    }
    scoreboardContent.innerHTML = `<div class="card"><p>${msg}</p></div>`;
  }

  // Render active season weekly/player data
  renderActiveWeekly(seasonData);
  renderActivePlayers(seasonData);

  // Check if playoffs have started (QF/SF/Finals data exists)
  const rounds = new Set([
    ...(seasonData.weekly_batting || []).map(b => b.round),
    ...(seasonData.weekly_pitching || []).map(p => p.round)
  ]);
  const hasPlayoffData = rounds.has('QF') || rounds.has('SF') || rounds.has('Finals');

  // Bracket section on scoreboard
  const bracketContainer = document.getElementById('scoreboard-bracket');
  if (bracketContainer) {
    if (hasPlayoffData) {
      // Collapse pool play when playoffs have started
      const ppBody = document.getElementById('sb-poolplay-body');
      const ppBtn = document.getElementById('sb-poolplay-toggle-btn');
      if (ppBody) ppBody.style.display = 'none';
      if (ppBtn) ppBtn.textContent = 'Show';
      bracketContainer.innerHTML = '<div class="card"><h2>Playoff Bracket</h2><p class="text-muted">Bracket will be available for completed seasons.</p></div>';
    } else {
      bracketContainer.innerHTML = '';
    }
  }
}

function renderActiveScoreboardTabs(seasonData, managerScores, managers) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  // Pool groups from manager pool assignments
  const poolGroups = {};
  managers.forEach(m => {
    if (m.pool) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });
  const hasPools = Object.keys(poolGroups).length > 0;

  // Compute per-period scores — include ALL pool-assigned managers at 0
  function periodScores(roundFilter) {
    const mgrMap = {};
    managers.forEach(m => {
      if (m.pool) mgrMap[m.name] = { manager: m.name, batting: 0, pitching: 0, total: 0 };
    });
    batting.filter(b => roundFilter.includes(b.round)).forEach(b => {
      const mgr = b.manager; // use stored manager — banked points
      if (!mgr) return;
      if (!mgrMap[mgr]) mgrMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
      mgrMap[mgr].batting += (b.weekly_score || 0);
    });
    pitching.filter(p => roundFilter.includes(p.round)).forEach(p => {
      const mgr = p.manager;
      if (!mgr) return;
      if (!mgrMap[mgr]) mgrMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
      mgrMap[mgr].pitching += (p.weekly_score || 0);
    });
    return Object.values(mgrMap).map(m => {
      m.batting = Math.round(m.batting * 100) / 100;
      m.pitching = Math.round(m.pitching * 100) / 100;
      m.total = Math.round((m.batting + m.pitching) * 100) / 100;
      return m;
    }).sort((a, b) => b.total - a.total);
  }

  const pp1Scores = periodScores(['PP1', 'PP1P']);
  const pp2Scores = periodScores(['PP2', 'PP2P']);

  // Pool Play Overall = combined PP1 + PP2
  const overallMap = {};
  managers.forEach(m => {
    if (m.pool) overallMap[m.name] = { manager: m.name, batting: 0, pitching: 0, total: 0 };
  });
  [...pp1Scores, ...pp2Scores].forEach(s => {
    if (!overallMap[s.manager]) overallMap[s.manager] = { manager: s.manager, batting: 0, pitching: 0, total: 0 };
    overallMap[s.manager].batting += s.batting;
    overallMap[s.manager].pitching += s.pitching;
  });
  const overallScores = Object.values(overallMap).map(m => {
    m.batting = Math.round(m.batting * 100) / 100;
    m.pitching = Math.round(m.pitching * 100) / 100;
    m.total = Math.round((m.batting + m.pitching) * 100) / 100;
    return m;
  }).sort((a, b) => b.total - a.total);

  // ---- Determine PP1 and PP2 pool winners ----
  const pp1Winners = {}; // poolNum → manager name
  const pp2Winners = {};
  Object.keys(poolGroups).forEach(poolNum => {
    const poolMembers = poolGroups[poolNum];
    const pp1Pool = pp1Scores.filter(s => poolMembers.includes(s.manager)).sort((a, b) => b.total - a.total);
    if (pp1Pool.length > 0 && pp1Pool[0].total > 0) pp1Winners[poolNum] = pp1Pool[0].manager;
    const pp2Pool = pp2Scores.filter(s => poolMembers.includes(s.manager)).sort((a, b) => b.total - a.total);
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
    Object.keys(poolGroups).sort().forEach(poolNum => {
      const poolMembers = poolGroups[poolNum];
      const poolScores = scores.filter(s => poolMembers.includes(s.manager)).sort((a, b) => b.total - a.total);
      html += `<div class="pool-card"><h3>Pool ${poolNum}</h3>
        <table class="data-table compact-table">
          <thead><tr><th>#</th><th>Manager</th><th>Bat</th><th>Pit</th><th>Total</th></tr></thead>
          <tbody>`;
      poolScores.forEach((m, i) => {
        const cls = hlClass(m.manager, section);
        html += `<tr>
          <td class="rank">${i + 1}</td>
          <td><strong class="${cls}">${m.manager}</strong></td>
          <td class="num">${fmt(m.batting)}</td>
          <td class="num">${fmt(m.pitching)}</td>
          <td class="num"><strong>${fmt(m.total)}</strong></td>
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
    managers.forEach(m => { if (m.pool) mgrPool[m.name] = m.pool; });
    let tbl = `<table class="data-table compact-table">
      <thead><tr><th>#</th><th>Manager</th><th>Pool</th><th>Bat</th><th>Pit</th><th>Total</th></tr></thead><tbody>`;
    scores.forEach((m, i) => {
      const cls = hlClass(m.manager, 'overall');
      tbl += `<tr>
        <td class="rank">${i + 1}</td>
        <td><strong class="${cls}">${m.manager}</strong></td>
        <td>${mgrPool[m.manager] || ''}</td>
        <td class="num">${fmt(m.batting)}</td>
        <td class="num">${fmt(m.pitching)}</td>
        <td class="num"><strong>${fmt(m.total)}</strong></td>
      </tr>`;
    });
    tbl += '</tbody></table>';
    return tbl;
  }

  // ---- Build full HTML ----
  // Check if playoff data exists — if so, pool play starts collapsed
  const rounds = new Set([...batting.map(b => b.round), ...pitching.map(p => p.round)]);
  const hasPlayoffData = rounds.has('QF') || rounds.has('SF') || rounds.has('Finals');
  const ppCollapsed = hasPlayoffData;

  let html = '';

  html += `<div class="card scoreboard-card sb-poolplay-section">
    <div class="sb-poolplay-header" onclick="togglePoolPlay()">
      <h2 style="margin:0;border:none;padding:0;">Pool Play Scoreboard</h2>
      <span class="btn btn-sm btn-secondary sb-poolplay-toggle" id="sb-poolplay-toggle-btn">${ppCollapsed ? 'Show' : 'Hide'}</span>
    </div>
    <div class="sb-poolplay-body" id="sb-poolplay-body" style="display:${ppCollapsed ? 'none' : 'block'};">`;

  // Pool Play Overall (combined PP1 + PP2, single list sorted by total)
  html += `<div class="scoreboard-section">
    <h3>Pool Play Overall</h3>
    ${renderOverallTable(overallScores)}
  </div>`;

  // Pool Play 1
  html += `<div class="scoreboard-section">
    <h3>Pool Play 1</h3>
    ${renderPoolSection(pp1Scores, 'Pool Play 1', 'pp1')}
  </div>`;

  // Pool Play 2
  html += `<div class="scoreboard-section">
    <h3>Pool Play 2</h3>
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
    [{ key: 'qf', has: hasQF, label: 'Quarterfinals' },
     { key: 'sf', has: hasSF, label: 'Semifinals' },
     { key: 'finals', has: hasFinals, label: 'Finals' }
    ].forEach(t => {
      if (!t.has) return;
      tabsHtml += `<button class="sb-tab ${first ? 'active' : ''}" data-period="${t.key}">${t.label}</button>`;
      first = false;
    });

    function renderPlayoffTable(scores) {
      if (scores.length === 0) return '<p>No data.</p>';
      let tbl = `<table class="data-table compact-table">
        <thead><tr><th>#</th><th>Manager</th><th>Bat</th><th>Pit</th><th>Total</th></tr></thead><tbody>`;
      scores.forEach((m, i) => {
        tbl += `<tr>
          <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
          <td><strong>${m.manager}</strong></td>
          <td class="num">${fmt(m.batting)}</td>
          <td class="num">${fmt(m.pitching)}</td>
          <td class="num"><strong>${fmt(m.total)}</strong></td>
        </tr>`;
      });
      tbl += '</tbody></table>';
      return tbl;
    }

    html += `<div class="card scoreboard-card">
      <div class="scoreboard-tabs" id="scoreboard-tabs">${tabsHtml}</div>`;
    let firstPeriod = true;
    if (hasQF) { html += `<div class="sb-period" id="sb-qf" ${!firstPeriod ? 'style="display:none"' : ''}>${renderPlayoffTable(periodScores(['QF']))}</div>`; firstPeriod = false; }
    if (hasSF) { html += `<div class="sb-period" id="sb-sf" ${!firstPeriod ? 'style="display:none"' : ''}>${renderPlayoffTable(periodScores(['SF']))}</div>`; firstPeriod = false; }
    if (hasFinals) { html += `<div class="sb-period" id="sb-finals" ${!firstPeriod ? 'style="display:none"' : ''}>${renderPlayoffTable(periodScores(['Finals']))}</div>`; firstPeriod = false; }
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
  const fixedBatting = batting.map(b => ({ ...b, manager: b.manager || '(Unassigned)' }));
  const fixedPitching = pitching.map(p => ({ ...p, manager: p.manager || '(Unassigned)' }));

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
  Object.values(_trendsCharts).forEach(c => { try { c.destroy(); } catch(e) {} });
  Object.keys(_trendsCharts).forEach(k => delete _trendsCharts[k]);
}

const CHART_COLORS = [
  '#1a3a5c','#ef4444','#10b981','#f59e0b','#8b5cf6',
  '#06b6d4','#f97316','#ec4899','#84cc16','#6366f1',
  '#14b8a6','#e11d48','#fb923c','#a78bfa','#34d399',
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
    battingData = (seasonData.data.batting_weekly || []).map(b => ({
      player: b.batter, manager: b.manager, round: b.round, week: b.week, weekly_score: b.weekly_score || 0
    }));
    pitchingData = (seasonData.data.pitching_weekly || []).map(p => ({
      player: p.pitcher, manager: p.manager, round: p.round, week: p.week, weekly_score: p.weekly_score || 0
    }));
  } else {
    teamWeekly = buildTeamWeekly(seasonData);
    battingData = (seasonData.weekly_batting || []).filter(b => b.manager).map(b => ({
      player: b.batter, manager: b.manager, round: b.round, week: b.week, weekly_score: b.weekly_score || 0
    }));
    pitchingData = (seasonData.weekly_pitching || []).filter(p => p.manager).map(p => ({
      player: p.pitcher, manager: p.manager, round: p.round, week: p.week, weekly_score: p.weekly_score || 0
    }));
  }

  if (teamWeekly.length === 0 && battingData.length === 0 && pitchingData.length === 0) {
    container.innerHTML = '<div class="card"><p>No scoring data available yet. Upload weekly stats via the Commissioner page.</p></div>';
    return;
  }

  // ---- Ordered weeks (chronological via SEASON_SCHEDULE) ----
  const allWeekKeys = new Set([
    ...teamWeekly.map(t => `${t.round}|${t.week}`),
    ...battingData.map(b => `${b.round}|${b.week}`),
    ...pitchingData.map(p => `${p.round}|${p.week}`),
  ]);

  // Map schedule entries to keyed objects, filter to present weeks
  const scheduleOrdered = SEASON_SCHEDULE
    .map(s => ({ key: `${s.round}|${s.week}`, round: s.round, week: s.week }))
    .filter(s => allWeekKeys.has(s.key));

  // Any rounds not in SEASON_SCHEDULE go at end
  const unknownKeys = [...allWeekKeys].filter(k => !scheduleOrdered.find(s => s.key === k));
  unknownKeys.forEach(k => {
    const [round, week] = k.split('|');
    scheduleOrdered.push({ key: k, round, week });
  });

  const orderedWeeks = scheduleOrdered;
  const rShort = { PP1: 'PP1', PP1P: 'PP1+', PP2: 'PP2', PP2P: 'PP2+', QF: 'QF', SF: 'SF', Finals: 'Fnls' };
  const dates = getScheduleDates();
  const chartLabels = orderedWeeks.map(w => {
    const base = `${rShort[w.round] || w.round} ${w.week.replace('Week ', 'W')}`;
    if (!dates) return base;
    const wi = weekIndexFromKey(w.round, w.week);
    if (wi < 0 || !dates[wi]) return base;
    return `${base} (${fmtDateRangeShort(dates[wi].start, dates[wi].end)})`;
  });

  // ---- Unique sets ----
  const allManagers = [...new Set([
    ...teamWeekly.map(t => t.manager),
    ...battingData.map(b => b.manager),
    ...pitchingData.map(p => p.manager),
  ])].sort();
  const allBatters = [...new Set(battingData.map(b => b.player))].sort();
  const allPitchers = [...new Set(pitchingData.map(p => p.player))].sort();

  // ---- Pool groups ----
  const managers = getManagers();
  const poolGroups = {};
  managers.forEach(m => {
    if (m.pool) {
      if (!poolGroups[m.pool]) poolGroups[m.pool] = [];
      poolGroups[m.pool].push(m.name);
    }
  });
  const poolNums = Object.keys(poolGroups).sort();
  const hasPools = poolNums.length > 0;

  // Build manager→pool lookup
  const mgrPoolMap = {};
  managers.forEach(m => { if (m.pool) mgrPoolMap[m.name] = m.pool; });

  // ---- State ----
  let selectedManagers = new Set(allManagers);
  let managerMode = 'weekly';
  let mgrsForBatters = new Set(allManagers);
  let mgrsForPitchers = new Set(allManagers);
  let selectedBatters = new Set();
  let selectedPitchers = new Set();

  // ---- Pool filter buttons HTML ----
  const poolBtnsHtml = hasPools ? `<div class="trends-control-row">
            <span class="trends-label">By Pool</span>
            ${poolNums.map(p => `<button class="btn btn-sm btn-secondary pool-filter-btn" data-pool="${p}">Pool ${p}</button>`).join('')}
          </div>` : '';
  const mgrPoolBtnsHtml = (prefix) => hasPools ? `<div class="trends-control-row">
            <span class="trends-label">By Pool</span>
            ${poolNums.map(p => `<button class="btn btn-sm btn-secondary pool-filter-btn" data-pool="${p}" data-prefix="${prefix}">Pool ${p}</button>`).join('')}
          </div>` : '';

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
    if (_trendsCharts[canvasId]) { try { _trendsCharts[canvasId].destroy(); } catch(e) {} }
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
          tooltip: { callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? fmt(ctx.parsed.y) : '—'}`
          }},
        },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 30 } },
          y: { title: { display: !!yLabel, text: yLabel }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }

  function buildManagerDatasets() {
    return [...selectedManagers].map(mgr => {
      const colorIdx = allManagers.indexOf(mgr);
      const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
      const weekly = orderedWeeks.map(w => {
        const entry = teamWeekly.find(t => t.manager === mgr && t.round === w.round && t.week === w.week);
        return entry ? entry.weekly_total : null;
      });
      let data = weekly;
      if (managerMode === 'cumulative') {
        let cum = 0;
        data = weekly.map(v => { if (v !== null) cum += v; return v !== null ? Math.round(cum * 100) / 100 : null; });
      }
      return { label: mgr, data, borderColor: color, backgroundColor: color + '28', tension: 0.3, spanGaps: true, pointRadius: 4, pointHoverRadius: 6 };
    });
  }

  function buildPlayerDatasets(sourceData, allPlayerList, selectedPlayers) {
    return [...selectedPlayers].map(player => {
      const colorIdx = allPlayerList.indexOf(player);
      const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
      const data = orderedWeeks.map(w => {
        const rows = sourceData.filter(d => d.player === player && d.round === w.round && d.week === w.week);
        return rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.weekly_score, 0) * 100) / 100 : null;
      });
      return { label: player, data, borderColor: color, backgroundColor: color + '28', tension: 0.3, spanGaps: true, pointRadius: 4, pointHoverRadius: 6 };
    });
  }

  function drawManagerChart() {
    const label = managerMode === 'cumulative' ? 'Cumulative Points' : 'Weekly Points';
    makeChart('trends-manager-chart', buildManagerDatasets(), label);
  }

  function getVisibleBatters() {
    return [...new Set(battingData.filter(b => mgrsForBatters.has(b.manager)).map(b => b.player))].sort();
  }

  function getVisiblePitchers() {
    return [...new Set(pitchingData.filter(p => mgrsForPitchers.has(p.manager)).map(p => p.player))].sort();
  }

  function drawBatterChart() {
    const visible = getVisibleBatters();
    const active = new Set([...selectedBatters].filter(p => visible.includes(p)));
    selectedBatters = active;
    const filtered = battingData.filter(b => mgrsForBatters.has(b.manager));
    makeChart('trends-batter-chart', buildPlayerDatasets(filtered, allBatters, selectedBatters), 'Weekly Points');
  }

  function drawPitcherChart() {
    const visible = getVisiblePitchers();
    const active = new Set([...selectedPitchers].filter(p => visible.includes(p)));
    selectedPitchers = active;
    const filtered = pitchingData.filter(p => mgrsForPitchers.has(p.manager));
    makeChart('trends-pitcher-chart', buildPlayerDatasets(filtered, allPitchers, selectedPitchers), 'Weekly Points');
  }

  // ---- Chip rendering ----
  function renderChips(containerId, items, selectedSet, onChange) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items.map(item =>
      `<button class="chip ${selectedSet.has(item) ? 'chip-active' : ''}" data-item="${item.replace(/"/g, '&quot;')}">${item.replace(/</g, '&lt;')}</button>`
    ).join('');
    el.querySelectorAll('.chip').forEach(chip => {
      chip.onclick = () => {
        const val = chip.dataset.item;
        if (selectedSet.has(val)) selectedSet.delete(val); else selectedSet.add(val);
        chip.classList.toggle('chip-active');
        onChange();
      };
    });
  }

  function refreshBatterPlayerChips() {
    const visible = getVisibleBatters();
    // Initialise selectedBatters with first 8 if empty
    if (selectedBatters.size === 0) visible.slice(0, 8).forEach(p => selectedBatters.add(p));
    renderChips('batter-chips', visible, selectedBatters, drawBatterChart);
  }

  function refreshPitcherPlayerChips() {
    const visible = getVisiblePitchers();
    if (selectedPitchers.size === 0) visible.slice(0, 8).forEach(p => selectedPitchers.add(p));
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
  container.querySelectorAll('.trends-view-toggle .type-btn').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.trends-view-toggle .type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.getElementById('trends-managers-panel').style.display = view === 'managers' ? '' : 'none';
      document.getElementById('trends-batters-panel').style.display = view === 'batters' ? '' : 'none';
      document.getElementById('trends-pitchers-panel').style.display = view === 'pitchers' ? '' : 'none';
      if (view === 'managers') drawManagerChart();
      else if (view === 'batters') { refreshBatterPlayerChips(); drawBatterChart(); }
      else if (view === 'pitchers') { refreshPitcherPlayerChips(); drawPitcherChart(); }
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
    allManagers.forEach(m => selectedManagers.add(m));
    renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);
    drawManagerChart();
  };
  document.getElementById('mgr-none-btn').onclick = () => {
    selectedManagers.clear();
    renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);
    drawManagerChart();
  };

  document.getElementById('bat-mgr-all-btn').onclick = () => {
    allManagers.forEach(m => mgrsForBatters.add(m));
    renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => { refreshBatterPlayerChips(); drawBatterChart(); });
    refreshBatterPlayerChips(); drawBatterChart();
  };
  document.getElementById('bat-mgr-none-btn').onclick = () => {
    mgrsForBatters.clear();
    renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => { refreshBatterPlayerChips(); drawBatterChart(); });
    selectedBatters.clear(); refreshBatterPlayerChips(); drawBatterChart();
  };
  document.getElementById('bat-all-btn').onclick = () => {
    getVisibleBatters().forEach(p => selectedBatters.add(p));
    refreshBatterPlayerChips(); drawBatterChart();
  };
  document.getElementById('bat-none-btn').onclick = () => {
    selectedBatters.clear(); refreshBatterPlayerChips(); drawBatterChart();
  };

  document.getElementById('pit-mgr-all-btn').onclick = () => {
    allManagers.forEach(m => mgrsForPitchers.add(m));
    renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => { refreshPitcherPlayerChips(); drawPitcherChart(); });
    refreshPitcherPlayerChips(); drawPitcherChart();
  };
  document.getElementById('pit-mgr-none-btn').onclick = () => {
    mgrsForPitchers.clear();
    renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => { refreshPitcherPlayerChips(); drawPitcherChart(); });
    selectedPitchers.clear(); refreshPitcherPlayerChips(); drawPitcherChart();
  };
  document.getElementById('pit-all-btn').onclick = () => {
    getVisiblePitchers().forEach(p => selectedPitchers.add(p));
    refreshPitcherPlayerChips(); drawPitcherChart();
  };
  document.getElementById('pit-none-btn').onclick = () => {
    selectedPitchers.clear(); refreshPitcherPlayerChips(); drawPitcherChart();
  };

  // ---- Pool filter buttons ----
  if (hasPools) {
    // Manager Trends pool buttons
    document.querySelectorAll('#trends-managers-panel .pool-filter-btn').forEach(btn => {
      btn.onclick = () => {
        const pool = btn.dataset.pool;
        const poolMembers = poolGroups[pool] || [];
        selectedManagers.clear();
        poolMembers.forEach(m => { if (allManagers.includes(m)) selectedManagers.add(m); });
        renderChips('manager-chips', allManagers, selectedManagers, drawManagerChart);
        drawManagerChart();
      };
    });

    // Batters pool buttons
    document.querySelectorAll('#trends-batters-panel .pool-filter-btn').forEach(btn => {
      btn.onclick = () => {
        const pool = btn.dataset.pool;
        const poolMembers = poolGroups[pool] || [];
        mgrsForBatters.clear();
        poolMembers.forEach(m => { if (allManagers.includes(m)) mgrsForBatters.add(m); });
        renderChips('batter-mgr-chips', allManagers, mgrsForBatters, () => { refreshBatterPlayerChips(); drawBatterChart(); });
        selectedBatters.clear(); refreshBatterPlayerChips(); drawBatterChart();
      };
    });

    // Pitchers pool buttons
    document.querySelectorAll('#trends-pitchers-panel .pool-filter-btn').forEach(btn => {
      btn.onclick = () => {
        const pool = btn.dataset.pool;
        const poolMembers = poolGroups[pool] || [];
        mgrsForPitchers.clear();
        poolMembers.forEach(m => { if (allManagers.includes(m)) mgrsForPitchers.add(m); });
        renderChips('pitcher-mgr-chips', allManagers, mgrsForPitchers, () => { refreshPitcherPlayerChips(); drawPitcherChart(); });
        selectedPitchers.clear(); refreshPitcherPlayerChips(); drawPitcherChart();
      };
    });
  }
}

// ============================================================
// Scoring Engine
// ============================================================
function calculateBattingScore(stats) {
  let score = 0;
  score += (stats['1b'] || 0) * SCORING.batting['1B'];
  score += (stats['2b'] || 0) * SCORING.batting['2B'];
  score += (stats['3b'] || 0) * SCORING.batting['3B'];
  score += (stats.hr || 0) * SCORING.batting['HR'];
  score += (stats.r || 0) * SCORING.batting['R'];
  score += (stats.rbi || 0) * SCORING.batting['RBI'];
  score += (stats.sb || 0) * SCORING.batting['SB'];
  score += (stats.bb || 0) * SCORING.batting['BB'];
  return score;
}

function calculatePitchingScore(stats) {
  let score = 0;
  score += (stats.w || 0) * SCORING.pitching['W'];
  score += (stats.qs || 0) * SCORING.pitching['QS'];
  score += (stats.cg || 0) * SCORING.pitching['CG'];
  score += (stats.cgso || 0) * SCORING.pitching['CGSO'];
  score += (stats.nh || 0) * SCORING.pitching['NH'];
  score += (stats.ip || 0) * SCORING.pitching['IP'];
  score += (stats.h || 0) * SCORING.pitching['H'];
  score += (stats.er || 0) * SCORING.pitching['ER'];
  score += (stats.bb || 0) * SCORING.pitching['BB'];
  score += (stats.k || 0) * SCORING.pitching['K'];
  return Math.round(score * 100) / 100;
}

// Repair any weekly data where 'manager' is an MLB team abbreviation instead of a WMMC manager name
function repairManagerAssignments(seasonData) {
  if (!seasonData || seasonData.status === 'completed') return false;

  const rosters = seasonData.rosters || {};
  let repaired = false;

  // Build player-to-manager lookup from rosters (per-week model)
  const playerToManager = {};
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    // Handle both old flat format and new per-week format
    if (Array.isArray(mgrRoster.batters) || Array.isArray(mgrRoster.pitchers)) {
      (mgrRoster.batters || []).forEach(b => { playerToManager[b] = managerName; });
      (mgrRoster.pitchers || []).forEach(p => { playerToManager[p] = managerName; });
    } else {
      for (const weekRoster of Object.values(mgrRoster)) {
        (weekRoster.batters || []).forEach(b => { if (!playerToManager[b]) playerToManager[b] = managerName; });
        (weekRoster.pitchers || []).forEach(p => { if (!playerToManager[p]) playerToManager[p] = managerName; });
      }
    }
  }

  // Only repair entries with null/empty manager (unassigned stats).
  // Never overwrite a valid stored manager — that would break banked points.
  (seasonData.weekly_batting || []).forEach(entry => {
    if (!entry.manager) {
      const correctManager = playerToManager[entry.batter];
      if (correctManager) {
        entry.manager = correctManager;
        repaired = true;
      }
    }
  });

  (seasonData.weekly_pitching || []).forEach(entry => {
    if (!entry.manager) {
      const correctManager = playerToManager[entry.pitcher];
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
      (seasonData.weekly_batting || []).forEach(b => { if (b.manager === mgr) uploadedWeeks.add(`${b.round}|${b.week}`); });
      (seasonData.weekly_pitching || []).forEach(p => { if (p.manager === mgr) uploadedWeeks.add(`${p.round}|${p.week}`); });
      // If no uploaded weeks yet, put them in the first schedule week
      if (uploadedWeeks.size === 0 && SEASON_SCHEDULE.length > 0) {
        uploadedWeeks.add(`${SEASON_SCHEDULE[0].round}|${SEASON_SCHEDULE[0].week}`);
      }
      uploadedWeeks.forEach(wk => {
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
    (weekRoster.batters || []).forEach(b => batters.add(b));
    (weekRoster.pitchers || []).forEach(p => pitchers.add(p));
  }
  return { batters: [...batters], pitchers: [...pitchers] };
}

// Build a player-to-manager lookup from rosters (union of all weeks)
function buildPlayerToManagerMap(seasonData) {
  const map = {};
  const rosters = (seasonData && seasonData.rosters) || {};
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
    for (const weekRoster of Object.values(mgrRoster)) {
      (weekRoster.batters || []).forEach(b => { if (!map[b]) map[b] = managerName; });
      (weekRoster.pitchers || []).forEach(p => { if (!map[p]) map[p] = managerName; });
    }
  }
  return map;
}

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


function computeManagerScores(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const managerMap = {};
  batting.forEach(b => {
    const mgr = b.manager; // use stored manager — points are banked at upload time
    if (!mgr) return;
    if (!managerMap[mgr]) managerMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
    managerMap[mgr].batting += (b.weekly_score || 0);
  });
  pitching.forEach(p => {
    const mgr = p.manager;
    if (!mgr) return;
    if (!managerMap[mgr]) managerMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
    managerMap[mgr].pitching += (p.weekly_score || 0);
  });

  return Object.values(managerMap).map(m => {
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

  // Build manager-to-pool lookup
  const managerPool = {};
  managers.forEach(m => { if (m.pool) managerPool[m.name] = 'Pool ' + m.pool; });

  const key = (r, w, m) => `${r}|${w}|${m}`;
  const map = {};

  batting.forEach(b => {
    const mgr = b.manager; // use stored manager — points are banked at upload/assign time
    if (!mgr) return;       // skip unassigned players
    const k = key(b.round, b.week, mgr);
    if (!map[k]) map[k] = { round: b.round, week: b.week, manager: mgr, pool: managerPool[mgr] || '', weekly_batting: 0, weekly_pitching: 0, weekly_total: 0 };
    map[k].weekly_batting += (b.weekly_score || 0);
  });

  pitching.forEach(p => {
    const mgr = p.manager;
    if (!mgr) return;
    const k = key(p.round, p.week, mgr);
    if (!map[k]) map[k] = { round: p.round, week: p.week, manager: mgr, pool: managerPool[mgr] || '', weekly_batting: 0, weekly_pitching: 0, weekly_total: 0 };
    map[k].weekly_pitching += (p.weekly_score || 0);
  });

  return Object.values(map).map(t => {
    t.weekly_batting = Math.round(t.weekly_batting * 100) / 100;
    t.weekly_pitching = Math.round(t.weekly_pitching * 100) / 100;
    t.weekly_total = Math.round((t.weekly_batting + t.weekly_pitching) * 100) / 100;
    return t;
  });
}

function countUploadedWeeks(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const weeks = new Set();
  batting.forEach(b => weeks.add(`${b.round}|${b.week}`));
  return weeks.size;
}

// ============================================================
// Season Schedule View
// ============================================================
// ============================================================
// Rosters Page
// ============================================================
let ROSTER_VIEWING_MANAGER = null; // name of the manager currently being viewed

function setupMyRoster() {
  if (!LOGGED_IN_EMAIL) return;

  const managers = getManagers();
  const loggedInMgr = managers.find(m => m.email && m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase());
  if (!loggedInMgr) return;

  const isCommissioner = !!loggedInMgr.commissioner;
  const managerBar = document.getElementById('roster-manager-bar');
  const managerSelect = document.getElementById('roster-manager-select');
  const titleEl = document.getElementById('roster-title');

  managerBar.style.display = 'block';

  if (isCommissioner) {
    // Commissioner: show dropdown to switch between any manager's roster
    managerSelect.style.display = '';
    managerSelect.innerHTML = managers.map(m =>
      `<option value="${m.name}"${m.name === loggedInMgr.name ? ' selected' : ''}>${m.name}${m.commissioner ? ' (Commissioner)' : ''}</option>`
    ).join('');

    managerSelect.onchange = () => {
      const selectedName = managerSelect.value;
      ROSTER_VIEWING_MANAGER = selectedName;
      titleEl.textContent = selectedName + "'s Roster";
      renderRosterData(selectedName, true);
    };

    document.getElementById('manual-update-section').style.display = 'block';
    setupManualUpdate();
  } else {
    // Regular manager: no dropdown needed
    managerSelect.style.display = 'none';
  }

  // Show the logged-in user's roster by default
  ROSTER_VIEWING_MANAGER = loggedInMgr.name;
  titleEl.textContent = loggedInMgr.name + "'s Roster";
  renderRosterData(loggedInMgr.name, isCommissioner);
}

function renderRosterData(managerName, isCommissioner) {
  const container = document.getElementById('roster-content');
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  const isActive = seasonData && seasonData.status === 'active';
  const p2m = isActive ? buildPlayerToManagerMap(seasonData) : {};

  // Migrate old flat rosters to per-week format if needed
  if (isActive) migrateRostersToWeekly(seasonData);

  // Compute per-period scores for this manager
  const periodScores = computeRosterPeriodScores(managerName, seasonData, p2m);

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
  periods.forEach(p => {
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

  // ---- Per-Week Roster Sections ----
  html += buildPerWeekRoster(managerName, isCommissioner, seasonData);

  // ---- Team Stats Breakdown ----
  html += buildTeamStatsBreakdown(managerName, seasonData, p2m);

  // ---- Player Swaps ----
  html += buildPlayerSwapsSection(managerName, isCommissioner, seasonData, p2m);

  container.innerHTML = html;
}

// Build per-week roster sections showing batters and pitchers for each week
function buildPerWeekRoster(managerName, isCommissioner, seasonData) {
  const isActive = !!(seasonData && seasonData.status === 'active');
  const isHistorical = !!(DATA && DATA.batting_weekly);

  const batting = isHistorical ? (DATA.batting_weekly || []) : (seasonData.weekly_batting || []);
  const pitching = isHistorical ? (DATA.pitching_weekly || []) : (seasonData.weekly_pitching || []);

  // Available players for commissioner add
  let availBatters = [];
  let availPitchers = [];
  if (isCommissioner && isActive) {
    const allPool = seasonData.batters_pool || [];
    const allPitPool = seasonData.pitchers_pool || [];
    availBatters = allPool.sort();
    availPitchers = allPitPool.sort();
  }

  // Determine which weeks have roster data or uploaded stats for this manager
  const weeksWithData = new Set();
  batting.filter(b => b.manager === managerName).forEach(b => weeksWithData.add(`${b.round}|${b.week}`));
  pitching.filter(p => p.manager === managerName).forEach(p => weeksWithData.add(`${p.round}|${p.week}`));

  // Also include weeks where this manager has a per-week roster
  if (isActive && seasonData.rosters && seasonData.rosters[managerName]) {
    Object.keys(seasonData.rosters[managerName]).forEach(wk => weeksWithData.add(wk));
  }

  // Build ordered list: SEASON_SCHEDULE order, most recent first
  const scheduleOrder = {};
  SEASON_SCHEDULE.forEach((s, i) => { scheduleOrder[`${s.round}|${s.week}`] = i; });
  const orderedWeeks = SEASON_SCHEDULE.map(s => `${s.round}|${s.week}`);
  // Only show weeks that have data or rosters, plus any schedule weeks for commissioner
  const weeksToShow = isCommissioner && isActive
    ? orderedWeeks // show all weeks for commissioner
    : orderedWeeks.filter(wk => weeksWithData.has(wk));

  if (weeksToShow.length === 0) return '<div class="card"><p class="text-muted">No roster data yet.</p></div>';

  // Find the latest week with data for highlighting
  let latestDataWeek = null;
  for (let i = orderedWeeks.length - 1; i >= 0; i--) {
    if (weeksWithData.has(orderedWeeks[i])) { latestDataWeek = orderedWeeks[i]; break; }
  }

  const safeMgr = managerName.replace(/'/g, "\\'");
  let html = '';

  // Show weeks in chronological order, latest week with data expanded
  weeksToShow.forEach(weekKey => {
    const [round, week] = weekKey.split('|');
    const schedEntry = SEASON_SCHEDULE.find(s => s.round === round && s.week === week);
    const label = schedEntry ? schedEntry.label : `${round} - ${week}`;
    const isCurrent = weekKey === latestDataWeek;

    // Get roster for this week
    const weekRoster = isActive ? getWeekRoster(seasonData, managerName, round, week) : { batters: [], pitchers: [] };

    // Get stat records for this week
    const weekBatting = batting.filter(b => b.manager === managerName && b.round === round && b.week === week);
    const weekPitching = pitching.filter(p => p.manager === managerName && p.round === round && p.week === week);

    // Compute week totals
    const batTotal = weekBatting.reduce((s, b) => s + (b.weekly_score || 0), 0);
    const pitTotal = weekPitching.reduce((s, p) => s + (p.weekly_score || 0), 0);
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
    weekBatting.forEach(b => { batStatMap[b.batter] = b; });

    // Show all rostered batters + any with stats
    const allBattersThisWeek = new Set([...weekRoster.batters, ...weekBatting.map(b => b.batter)]);
    if (allBattersThisWeek.size > 0) {
      html += '<div class="table-wrapper"><table class="data-table compact-table wrs-table"><thead><tr>';
      html += '<th>Player</th><th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Pts</th>';
      if (isCommissioner && isActive) html += '<th></th>';
      html += '</tr></thead><tbody>';
      [...allBattersThisWeek].sort((a, b) => ((batStatMap[b] || {}).weekly_score || 0) - ((batStatMap[a] || {}).weekly_score || 0)).forEach(batter => {
        const s = batStatMap[batter] || {};
        const onRoster = weekRoster.batters.includes(batter);
        const safeBatter = batter.replace(/'/g, "\\'");
        html += `<tr${onRoster ? '' : ' class="wrs-hist-row"'}>`;
        html += `<td>${batter}${onRoster ? '' : ' <span class="wrs-hist-tag">not rostered</span>'}</td>`;
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
        if (isCommissioner && isActive) {
          html += `<td class="num wrs-actions">`;
          html += `<button class="btn btn-sm btn-outline" onclick="editPlayerStats('${safeMgr}','batting','${safeBatter}','${weekKey}')" title="Edit stats">Edit</button>`;
          if (onRoster) {
            html += ` <button class="btn btn-sm btn-danger" onclick="removeFromRoster('${safeMgr}','batters','${safeBatter}','${weekKey}')">Drop</button>`;
          }
          html += `</td>`;
        }
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p class="text-muted" style="font-size:0.85rem;">No batters rostered this week.</p>';
    }
    // Commissioner: add batter for this week
    if (isCommissioner && isActive) {
      html += `<div class="roster-add-row">
        <select id="add-bat-${safeId}" class="form-select" style="max-width:200px;"><option value="">Add batter...</option>
          ${availBatters.filter(b => !weekRoster.batters.includes(b)).map(b => `<option value="${b}">${b}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary" onclick="addToRoster('${safeMgr}','batters','add-bat-${safeId}','${weekKey}')">Add</button>
      </div>`;
    }

    // Helper: render a pitching stat cell with manual highlight
    function pitStatCell(s, field, displayVal) {
      const manual = (s.manual_fields || []).includes(field);
      return `<td class="num${manual ? ' stat-manual' : ''}">${displayVal}</td>`;
    }

    // ---- Pitchers for this week ----
    html += `<div class="wrs-group-label" style="margin-top:0.75rem;">PITCHERS (${weekRoster.pitchers.length}) <span class="wrs-group-pts">${fmt(Math.round(pitTotal * 100) / 100)} pts</span></div>`;

    const pitStatMap = {};
    weekPitching.forEach(p => { pitStatMap[p.pitcher] = p; });

    const allPitchersThisWeek = new Set([...weekRoster.pitchers, ...weekPitching.map(p => p.pitcher)]);
    if (allPitchersThisWeek.size > 0) {
      html += '<div class="table-wrapper"><table class="data-table compact-table wrs-table"><thead><tr>';
      html += '<th>Player</th><th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Pts</th>';
      if (isCommissioner && isActive) html += '<th></th>';
      html += '</tr></thead><tbody>';
      [...allPitchersThisWeek].sort((a, b) => ((pitStatMap[b] || {}).weekly_score || 0) - ((pitStatMap[a] || {}).weekly_score || 0)).forEach(pitcher => {
        const s = pitStatMap[pitcher] || {};
        const onRoster = weekRoster.pitchers.includes(pitcher);
        const safePitcher = pitcher.replace(/'/g, "\\'");
        html += `<tr${onRoster ? '' : ' class="wrs-hist-row"'}>`;
        html += `<td>${pitcher}${onRoster ? '' : ' <span class="wrs-hist-tag">not rostered</span>'}</td>`;
        html += pitStatCell(s, 'gs', s.gs || 0);
        html += pitStatCell(s, 'w', s.w || 0);
        html += pitStatCell(s, 'qs', fmtDec(s.qs || 0));
        html += pitStatCell(s, 'cg', s.cg || 0);
        html += pitStatCell(s, 'cgso', s.cgso || 0);
        html += pitStatCell(s, 'nh', s.nh || 0);
        html += pitStatCell(s, 'ip', fmtDec(s.ip || 0));
        html += pitStatCell(s, 'h', s.h || 0);
        html += pitStatCell(s, 'er', s.er || 0);
        html += pitStatCell(s, 'bb', s.bb || 0);
        html += pitStatCell(s, 'k', s.k || 0);
        html += `<td class="num"><strong>${fmt(s.weekly_score || 0)}</strong></td>`;
        if (isCommissioner && isActive) {
          html += `<td class="num wrs-actions">`;
          html += `<button class="btn btn-sm btn-outline" onclick="editPlayerStats('${safeMgr}','pitching','${safePitcher}','${weekKey}')" title="Edit stats">Edit</button>`;
          if (onRoster) {
            html += ` <button class="btn btn-sm btn-danger" onclick="removeFromRoster('${safeMgr}','pitchers','${safePitcher}','${weekKey}')">Drop</button>`;
          }
          html += `</td>`;
        }
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p class="text-muted" style="font-size:0.85rem;">No pitchers rostered this week.</p>';
    }
    // Commissioner: add pitcher for this week
    if (isCommissioner && isActive) {
      html += `<div class="roster-add-row">
        <select id="add-pit-${safeId}" class="form-select" style="max-width:200px;"><option value="">Add pitcher...</option>
          ${availPitchers.filter(p => !weekRoster.pitchers.includes(p)).map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary" onclick="addToRoster('${safeMgr}','pitchers','add-pit-${safeId}','${weekKey}')">Add</button>
      </div>`;
    }

    // Week total footer
    html += `<div class="wrs-week-total">
      <span>Week Total</span>
      <span><strong>${fmt(weekTotal)}</strong> <span class="wrs-total-detail">(Bat: ${fmt(Math.round(batTotal * 100) / 100)} | Pit: ${fmt(Math.round(pitTotal * 100) / 100)})</span></span>
    </div>`;

    html += '</div></div>'; // .wrs-body, .wrs-section
  });

  return html;
}

// Compute per-scoring-period totals for a manager
function computeRosterPeriodScores(managerName, seasonData, p2m) {
  const result = {};
  let batting, pitching;

  if (DATA && DATA.team_weekly) {
    // Historical season - use pre-computed team_weekly
    const entries = DATA.team_weekly.filter(t => t.manager === managerName);
    const roundMap = {};
    entries.forEach(t => {
      if (!roundMap[t.round]) roundMap[t.round] = { batting: 0, pitching: 0, total: 0 };
      roundMap[t.round].batting += (t.weekly_batting || 0);
      roundMap[t.round].pitching += (t.weekly_pitching || 0);
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

  batting = seasonData.weekly_batting || [];
  pitching = seasonData.weekly_pitching || [];

  batting.forEach(b => {
    if (b.manager !== managerName) return; // use stored manager — banked points
    if (!result[b.round]) result[b.round] = { batting: 0, pitching: 0, total: 0 };
    result[b.round].batting += (b.weekly_score || 0);
  });
  pitching.forEach(p => {
    if (p.manager !== managerName) return;
    if (!result[p.round]) result[p.round] = { batting: 0, pitching: 0, total: 0 };
    result[p.round].pitching += (p.weekly_score || 0);
  });

  for (const data of Object.values(result)) {
    data.batting = Math.round(data.batting * 100) / 100;
    data.pitching = Math.round(data.pitching * 100) / 100;
    data.total = Math.round((data.batting + data.pitching) * 100) / 100;
  }
  return result;
}

// Compute per-player total scores for a manager's roster
function computePlayerTotals(managerName, type, seasonData, p2m) {
  const scores = {};

  if (DATA) {
    // Historical season
    const weekly = type === 'batting' ? (DATA.batting_weekly || []) : (DATA.pitching_weekly || []);
    const nameKey = type === 'batting' ? 'batter' : 'pitcher';
    weekly.filter(e => e.manager === managerName).forEach(e => {
      const name = e[nameKey];
      scores[name] = (scores[name] || 0) + (e.weekly_score || 0);
    });
  } else if (seasonData && seasonData.status === 'active') {
    const weekly = type === 'batting' ? (seasonData.weekly_batting || []) : (seasonData.weekly_pitching || []);
    const nameKey = type === 'batting' ? 'batter' : 'pitcher';
    weekly.forEach(e => {
      if (e.manager !== managerName) return; // use stored manager — banked points
      scores[e[nameKey]] = (scores[e[nameKey]] || 0) + (e.weekly_score || 0);
    });
  }

  // Round values
  for (const key of Object.keys(scores)) {
    scores[key] = Math.round(scores[key] * 100) / 100;
  }
  return scores;
}

// Compute per-player stat totals (all individual stats aggregated across weeks)
function computePlayerStatTotals(managerName, type, seasonData, p2m) {
  const totals = {};
  const battingKeys = ['abs', '1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb'];
  const pitchingKeys = ['gs', 'w', 'qs', 'cg', 'cgso', 'nh', 'ip', 'h', 'er', 'bb', 'k'];
  const statKeys = type === 'batting' ? battingKeys : pitchingKeys;
  const nameKey = type === 'batting' ? 'batter' : 'pitcher';

  let weekly, filterFn;
  if (DATA) {
    weekly = type === 'batting' ? (DATA.batting_weekly || []) : (DATA.pitching_weekly || []);
    filterFn = e => e.manager === managerName;
  } else if (seasonData && seasonData.status === 'active') {
    weekly = type === 'batting' ? (seasonData.weekly_batting || []) : (seasonData.weekly_pitching || []);
    filterFn = e => e.manager === managerName; // use stored manager — banked points
  } else {
    return totals;
  }

  weekly.filter(filterFn).forEach(e => {
    const name = e[nameKey];
    if (!totals[name]) {
      totals[name] = {};
      statKeys.forEach(k => { totals[name][k] = 0; });
      totals[name].points = 0;
    }
    statKeys.forEach(k => { totals[name][k] += parseFloat(e[k]) || 0; });
    totals[name].points += (e.weekly_score || 0);
  });

  for (const player of Object.keys(totals)) {
    statKeys.forEach(k => { totals[player][k] = Math.round(totals[player][k] * 100) / 100; });
    totals[player].points = Math.round(totals[player].points * 100) / 100;
  }
  return totals;
}

// Compute season-total rank for each player among ALL players of same type
function computePlayerRankings(type, seasonData, p2m) {
  const nameKey = type === 'batting' ? 'batter' : 'pitcher';
  let weekly;
  if (DATA) {
    weekly = type === 'batting' ? (DATA.batting_weekly || []) : (DATA.pitching_weekly || []);
  } else if (seasonData && seasonData.status === 'active') {
    weekly = type === 'batting' ? (seasonData.weekly_batting || []) : (seasonData.weekly_pitching || []);
  } else {
    return {};
  }

  const seasonScores = {};
  weekly.forEach(e => {
    const name = e[nameKey];
    seasonScores[name] = (seasonScores[name] || 0) + (e.weekly_score || 0);
  });

  const sorted = Object.entries(seasonScores).sort((a, b) => b[1] - a[1]);
  const rankings = {};
  sorted.forEach(([name], i) => {
    rankings[name] = { overallRank: i + 1, totalPlayers: sorted.length };
  });
  return rankings;
}

window.toggleWeeklyScoring = function(safeId) {
  const body = document.getElementById(`wrs-body-${safeId}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  const header = body.previousElementSibling;
  if (header) header.classList.toggle('wrs-open', !isOpen);
};

// ---- Team Stats Breakdown (accordion by scoring period) ----
const BREAKDOWN_PERIODS = [
  { key: 'PP1',    label: 'Pool Play 1',    weekRange: 'Weeks 1–5',   colorClass: 'period-pp1' },
  { key: 'PP2',    label: 'Pool Play 2',    weekRange: 'Weeks 6–10',  colorClass: 'period-pp2' },
  { key: 'QF',     label: 'Quarterfinals',  weekRange: 'Weeks 11–12', colorClass: 'period-qf' },
  { key: 'SF',     label: 'Semifinals',     weekRange: 'Weeks 13–14', colorClass: 'period-sf' },
  { key: 'Finals', label: 'Finals',         weekRange: 'Weeks 15–17', colorClass: 'period-finals' },
];

function buildTeamStatsBreakdown(managerName, seasonData, p2m) {
  // Determine data source
  const isHistorical = !!(DATA && DATA.batting_weekly);
  const isActive = !!(seasonData && seasonData.status === 'active');
  if (!isHistorical && !isActive) return '';

  let html = `<div class="card team-stats-breakdown">
    <h2>Team Stats Breakdown</h2>
    <p class="text-muted" style="margin-bottom:1rem;">Performance by round and week</p>`;

  BREAKDOWN_PERIODS.forEach(period => {
    // Aggregate weekly totals for this period
    const weekTotals = {}; // { 'Week 1': { batting: X, pitching: Y } }
    const batterPeriodTotals = {};
    const pitcherPeriodTotals = {};

    if (isHistorical) {
      (DATA.batting_weekly || [])
        .filter(e => e.manager === managerName && e.round === period.key)
        .forEach(e => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].batting += (e.weekly_score || 0);
          batterPeriodTotals[e.batter] = (batterPeriodTotals[e.batter] || 0) + (e.weekly_score || 0);
        });
      (DATA.pitching_weekly || [])
        .filter(e => e.manager === managerName && e.round === period.key)
        .forEach(e => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].pitching += (e.weekly_score || 0);
          pitcherPeriodTotals[e.pitcher] = (pitcherPeriodTotals[e.pitcher] || 0) + (e.weekly_score || 0);
        });
    } else if (isActive) {
      (seasonData.weekly_batting || [])
        .filter(e => e.round === period.key && e.manager === managerName)
        .forEach(e => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].batting += (e.weekly_score || 0);
          batterPeriodTotals[e.batter] = (batterPeriodTotals[e.batter] || 0) + (e.weekly_score || 0);
        });
      (seasonData.weekly_pitching || [])
        .filter(e => e.round === period.key && e.manager === managerName)
        .forEach(e => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].pitching += (e.weekly_score || 0);
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
    sortedWeeks.forEach(week => {
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
              <span class="period-player-name">${name}</span>
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
              <span class="period-player-name">${name}</span>
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

window.togglePeriodSection = function(periodKey) {
  const body = document.getElementById(`period-body-${periodKey}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  const header = body.previousElementSibling;
  if (header) header.classList.toggle('period-open', !isOpen);
};

// ---- Player Swaps Section ----
const SWAP_REASONS = [
  'Free Swap (one per round)',
  'IL Swap',
  'Drop Swap',
  'Trade Swap',
];

function getSeasonSwaps(seasonData) {
  if (DATA && DATA.swaps) return DATA.swaps; // historical
  if (seasonData && seasonData.swaps) return seasonData.swaps; // active
  return [];
}

function buildPlayerSwapsSection(managerName, isCommissioner, seasonData, p2m) {
  const isActive = !!(seasonData && seasonData.status === 'active');
  const isHistorical = !!(DATA && DATA.swaps);

  // Gather all swaps for this manager
  const allSwaps = getSeasonSwaps(seasonData);
  const emailMap = (DATA && DATA.email_map) ? DATA.email_map : {};
  const managers = getManagers();
  const managerEmail = ROSTER_EMAIL;

  // For active season swaps, filter by manager field; for historical, filter by email
  const mySwaps = allSwaps.filter(s => {
    if (s.manager) return s.manager === managerName;
    return (emailMap[s.email] || s.email) === managerName;
  });

  const pendingCount = mySwaps.filter(s => s.status === 'pending').length;
  const approvedCount = mySwaps.filter(s => !s.status || s.status === 'approved').length;

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
    for (const [mgrName, mgrRoster] of Object.entries(seasonData.rosters || {})) {
      for (const weekRoster of Object.values(mgrRoster)) {
        (weekRoster.batters || []).forEach(b => rosteredBatters.add(b));
        (weekRoster.pitchers || []).forEach(p => rosteredPitchers.add(p));
      }
    }
    const availBatters = (seasonData.batters_pool || []).filter(b => !rosteredBatters.has(b)).sort();
    const availPitchers = (seasonData.pitchers_pool || []).filter(p => !rosteredPitchers.has(p)).sort();

    html += `<div class="swap-form-card">
      <h3>Request a Swap</h3>
      <div class="swap-form-grid">
        <div class="swap-form-field">
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
            ${roster.batters.sort().map(b => `<option value="${b}" data-type="batter">${b}</option>`).join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-player-in">Player In (available)</label>
          <select id="swap-player-in" class="form-select">
            <option value="">Select replacement player...</option>
            ${availBatters.map(b => `<option value="${b}">${b}</option>`).join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-reason">Transaction Reason</label>
          <select id="swap-reason" class="form-select">
            <option value="">Select reason...</option>
            ${SWAP_REASONS.map(r => `<option value="${r}">${r}</option>`).join('')}
          </select>
        </div>
        <div class="swap-form-field">
          <label for="swap-date">Swap Date</label>
          <input type="date" id="swap-date" class="form-select" value="${new Date().toISOString().split('T')[0]}">
        </div>
      </div>
      <div style="margin-top:0.75rem;">
        <button class="btn btn-primary" onclick="submitSwapRequest('${managerName.replace(/'/g, "\\'")}')">Submit Request</button>
      </div>
      <p id="swap-form-error" class="error-text" style="display:none;margin-top:0.5rem;"></p>
      <p id="swap-form-success" class="success-text" style="display:none;margin-top:0.5rem;"></p>
    </div>`;

    // Store roster data as data attributes for the type toggle to use
    html += `<script type="application/json" id="swap-roster-data">${JSON.stringify({
      batters: roster.batters.sort(),
      pitchers: roster.pitchers.sort(),
      availBatters: availBatters,
      availPitchers: availPitchers
    })}</script>`;
  }

  // Commissioner: pending swaps from ALL managers
  if (isCommissioner && isActive) {
    const pendingSwaps = allSwaps.filter(s => s.status === 'pending');
    if (pendingSwaps.length > 0) {
      html += `<div class="swap-pending-card">
        <h3>Pending Approvals</h3>`;
      pendingSwaps.forEach(s => {
        html += `<div class="swap-pending-item" id="swap-item-${s.id}">
          <div class="swap-pending-header">
            <strong>${s.manager}</strong>
            <span class="swap-badge swap-badge-pending">Pending</span>
          </div>
          <div class="swap-pending-details">
            <span>${s.player_out} &rarr; ${s.player_in}</span>
            <span class="swap-detail-reason">${s.reason}</span>
            <span class="swap-detail-date">${s.swap_date || ''}</span>
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

  // All Swaps table (compact)
  html += `<div class="swap-list-section">
    <h3>All Swaps</h3>`;
  if (mySwaps.length > 0) {
    const sorted = [...mySwaps].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    html += '<div class="table-wrapper"><table class="data-table compact-table swap-table"><thead><tr>';
    html += '<th>Player In</th><th>Player Out</th><th>Reason</th><th>Date</th><th>Status</th>';
    html += '</tr></thead><tbody>';
    sorted.forEach(s => {
      const status = s.status || 'approved';
      const badgeClass = status === 'approved' ? 'swap-badge-approved'
        : status === 'pending' ? 'swap-badge-pending'
        : 'swap-badge-denied';
      const badgeLabel = status.charAt(0).toUpperCase() + status.slice(1);
      const date = s.swap_date || (s.timestamp ? s.timestamp.split(' ')[0] : '');
      html += `<tr>`;
      html += `<td>${s.player_in || '—'}</td>`;
      html += `<td>${s.player_out || '—'}</td>`;
      html += `<td>${s.reason || ''}</td>`;
      html += `<td>${date}</td>`;
      html += `<td><span class="swap-badge ${badgeClass}">${badgeLabel}</span></td>`;
      html += `</tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="text-muted">No swaps recorded.</p>';
  }
  html += '</div>';

  html += '</div>'; // .player-swaps-section
  return html;
}

// Swap form: toggle between Batter and Pitcher
window.swapTypeToggle = function(type) {
  const batterBtn = document.getElementById('swap-type-batter');
  const pitcherBtn = document.getElementById('swap-type-pitcher');
  const outSelect = document.getElementById('swap-player-out');
  const inSelect = document.getElementById('swap-player-in');
  const dataEl = document.getElementById('swap-roster-data');
  if (!dataEl) return;

  const data = JSON.parse(dataEl.textContent);

  if (type === 'batter') {
    batterBtn.classList.add('active');
    pitcherBtn.classList.remove('active');
    outSelect.innerHTML = '<option value="">Select player to swap out...</option>'
      + data.batters.map(b => `<option value="${b}">${b}</option>`).join('');
    inSelect.innerHTML = '<option value="">Select replacement player...</option>'
      + data.availBatters.map(b => `<option value="${b}">${b}</option>`).join('');
  } else {
    pitcherBtn.classList.add('active');
    batterBtn.classList.remove('active');
    outSelect.innerHTML = '<option value="">Select player to swap out...</option>'
      + data.pitchers.map(p => `<option value="${p}">${p}</option>`).join('');
    inSelect.innerHTML = '<option value="">Select replacement player...</option>'
      + data.availPitchers.map(p => `<option value="${p}">${p}</option>`).join('');
  }
};

// Submit a swap request
window.submitSwapRequest = function(managerName) {
  const errEl = document.getElementById('swap-form-error');
  const succEl = document.getElementById('swap-form-success');
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  const playerOut = document.getElementById('swap-player-out').value;
  const playerIn = document.getElementById('swap-player-in').value;
  const reason = document.getElementById('swap-reason').value;
  const swapDate = document.getElementById('swap-date').value;

  if (!playerOut || !playerIn || !reason || !swapDate) {
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

  const swap = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    email: ROSTER_EMAIL,
    manager: managerName,
    player_out: playerOut,
    player_in: playerIn,
    reason: reason,
    swap_date: swapDate,
    status: 'pending',
  };

  sd.swaps.push(swap);
  saveSeason(SELECTED_SEASON, sd);

  // Re-render entire roster view
  const isComm = getManagers().some(m => m.email.toLowerCase() === ROSTER_EMAIL.toLowerCase() && m.commissioner);
  renderRosterData(managerName, isComm);
};

// Commissioner: approve a swap
window.approveSwap = function(swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find(s => s.id === swapId);
  if (!swap) return;

  // Execute the roster swap using per-week model
  if (sd.rosters && sd.rosters[swap.manager]) {
    const mgrRoster = sd.rosters[swap.manager];
    // Determine if player_out is a batter or pitcher by checking all weeks
    let playerType = null;
    for (const weekRoster of Object.values(mgrRoster)) {
      if ((weekRoster.batters || []).includes(swap.player_out)) { playerType = 'batters'; break; }
      if ((weekRoster.pitchers || []).includes(swap.player_out)) { playerType = 'pitchers'; break; }
    }

    if (playerType) {
      // If swap has a specific week_key, only swap in that week; otherwise swap in all weeks where player_out appears
      const weekKeys = swap.week_key ? [swap.week_key] : Object.keys(mgrRoster);
      weekKeys.forEach(wk => {
        const weekRoster = mgrRoster[wk];
        if (!weekRoster) return;
        const arr = weekRoster[playerType] || [];
        if (arr.includes(swap.player_out)) {
          weekRoster[playerType] = arr.filter(p => p !== swap.player_out);
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
  saveSeason(SELECTED_SEASON, sd);

  // Find logged-in manager name and re-render
  const mgrs = getManagers();
  const mgr = mgrs.find(m => m.email.toLowerCase() === ROSTER_EMAIL.toLowerCase());
  if (mgr) renderRosterData(mgr.name, true);
};

// Commissioner: deny a swap
window.denySwap = function(swapId) {
  if (!confirm('Deny this swap request?')) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find(s => s.id === swapId);
  if (!swap) return;

  swap.status = 'denied';
  swap.reviewed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveSeason(SELECTED_SEASON, sd);

  const mgrs = getManagers();
  const mgr = mgrs.find(m => m.email.toLowerCase() === ROSTER_EMAIL.toLowerCase());
  if (mgr) renderRosterData(mgr.name, true);
};

// Commissioner: show inline edit form for a swap
window.editSwapInline = function(swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find(s => s.id === swapId);
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
      (weekRoster.batters || []).forEach(b => rosteredAll.add(b));
      (weekRoster.pitchers || []).forEach(p => rosteredAll.add(p));
    }
  }
  const pool = isBatter ? (sd.batters_pool || []) : (sd.pitchers_pool || []);
  const availPlayers = pool.filter(p => !rosteredAll.has(p) || p === swap.player_in).sort();

  editDiv.innerHTML = `
    <div class="swap-edit-grid">
      <div class="swap-form-field">
        <label>Player Out</label>
        <select id="edit-out-${swapId}" class="form-select">
          ${rosterPlayers.sort().map(p => `<option value="${p}" ${p === swap.player_out ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="swap-form-field">
        <label>Player In</label>
        <select id="edit-in-${swapId}" class="form-select">
          ${availPlayers.map(p => `<option value="${p}" ${p === swap.player_in ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="swap-form-field">
        <label>Reason</label>
        <select id="edit-reason-${swapId}" class="form-select">
          ${SWAP_REASONS.map(r => `<option value="${r}" ${r === swap.reason ? 'selected' : ''}>${r}</option>`).join('')}
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
window.saveSwapEdit = function(swapId) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) return;

  const swap = sd.swaps.find(s => s.id === swapId);
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
  const mgr = mgrs.find(m => m.email.toLowerCase() === ROSTER_EMAIL.toLowerCase());
  if (mgr) renderRosterData(mgr.name, true);
};

// Commissioner: cancel editing a swap
window.cancelSwapEdit = function(swapId) {
  const editDiv = document.getElementById(`swap-edit-${swapId}`);
  const actionsDiv = document.getElementById(`swap-actions-${swapId}`);
  if (editDiv) editDiv.style.display = 'none';
  if (actionsDiv) actionsDiv.style.display = 'flex';
};

// ============================================================
// Manual Update (Commissioner)
// ============================================================
function setupManualUpdate() {
  const managers = getManagers();
  const managerSelect = document.getElementById('manual-manager');
  const weekSelect = document.getElementById('manual-week');
  const battingBtn = document.getElementById('manual-type-batting');
  const pitchingBtn = document.getElementById('manual-type-pitching');
  const saveBtn = document.getElementById('manual-save-btn');

  // Populate manager dropdown
  managerSelect.innerHTML = managers.map(m => `<option value="${m.name}">${m.name}</option>`).join('');

  // Populate week dropdown
  const _manualDates = getScheduleDates();
  weekSelect.innerHTML = SEASON_SCHEDULE.map((s, i) => {
    const d = _manualDates && _manualDates[i] ? ` (${fmtDateRangeShort(_manualDates[i].start, _manualDates[i].end)})` : '';
    return `<option value="${i}">${s.label}${d}</option>`;
  }).join('');

  // Type toggle
  let manualType = 'batting';

  function populateManualPlayerDropdown() {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    const playerSelect = document.getElementById('manual-player-name');
    if (!sd || sd.status !== 'active' || !playerSelect) return;

    const rosteredBatters = new Set();
    const rosteredPitchers = new Set();
    Object.values(sd.rosters || {}).forEach(r => {
      (r.batters || []).forEach(b => rosteredBatters.add(b));
      (r.pitchers || []).forEach(p => rosteredPitchers.add(p));
    });

    let availPlayers;
    if (manualType === 'batting') {
      availPlayers = (sd.batters_pool || []).filter(b => !rosteredBatters.has(b)).sort();
    } else {
      availPlayers = (sd.pitchers_pool || []).filter(p => !rosteredPitchers.has(p)).sort();
    }
    playerSelect.innerHTML = '<option value="">Select player...</option>'
      + availPlayers.map(p => `<option value="${p}">${p}</option>`).join('');
  }

  battingBtn.onclick = () => {
    manualType = 'batting';
    battingBtn.classList.add('active');
    pitchingBtn.classList.remove('active');
    document.getElementById('manual-batting-fields').style.display = 'block';
    document.getElementById('manual-pitching-fields').style.display = 'none';
    document.getElementById('manual-score-preview').innerHTML = '';
    populateManualPlayerDropdown();
  };

  pitchingBtn.onclick = () => {
    manualType = 'pitching';
    pitchingBtn.classList.add('active');
    battingBtn.classList.remove('active');
    document.getElementById('manual-batting-fields').style.display = 'none';
    document.getElementById('manual-pitching-fields').style.display = 'block';
    document.getElementById('manual-score-preview').innerHTML = '';
    populateManualPlayerDropdown();
  };

  managerSelect.onchange = populateManualPlayerDropdown;

  // Live score preview on input change
  const allInputs = document.querySelectorAll('#manual-batting-fields input, #manual-pitching-fields input');
  allInputs.forEach(input => {
    input.addEventListener('input', () => {
      const score = calculateManualScore(manualType);
      document.getElementById('manual-score-preview').innerHTML =
        `<strong>Calculated Score: ${fmt(score)}</strong>`;
    });
  });

  // Save button
  saveBtn.onclick = () => {
    const manager = managerSelect.value;
    const playerName = document.getElementById('manual-player-name').value;
    const weekIndex = parseInt(weekSelect.value);

    if (!playerName) {
      document.getElementById('manual-update-status').innerHTML = '<p class="error-text">Please select a player.</p>';
      return;
    }

    const scheduleWeek = SEASON_SCHEDULE[weekIndex];
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];

    if (!sd || sd.status === 'completed') {
      document.getElementById('manual-update-status').innerHTML = '<p class="error-text">Cannot update a completed season.</p>';
      return;
    }

    if (manualType === 'batting') {
      if (!sd.weekly_batting) sd.weekly_batting = [];

      const stats = {
        '1b': parseNum(document.getElementById('manual-1b').value),
        '2b': parseNum(document.getElementById('manual-2b').value),
        '3b': parseNum(document.getElementById('manual-3b').value),
        hr: parseNum(document.getElementById('manual-hr').value),
        r: parseNum(document.getElementById('manual-r').value),
        rbi: parseNum(document.getElementById('manual-rbi').value),
        sb: parseNum(document.getElementById('manual-sb').value),
        bb: parseNum(document.getElementById('manual-bb-bat').value),
        abs: parseNum(document.getElementById('manual-ab').value),
      };

      const weeklyScore = calculateBattingScore(stats);

      // Compute cumulative total for this batter
      const batterTotals = {};
      sd.weekly_batting.forEach(b => {
        if (!batterTotals[b.batter]) batterTotals[b.batter] = 0;
        batterTotals[b.batter] += (b.weekly_score || 0);
      });
      const previousTotal = batterTotals[playerName] || 0;

      // Remove existing entry for same player/manager/week if any
      sd.weekly_batting = sd.weekly_batting.filter(b =>
        !(b.round === scheduleWeek.round && b.week === scheduleWeek.week && b.manager === manager && b.batter === playerName)
      );

      sd.weekly_batting.push({
        round: scheduleWeek.round,
        week: scheduleWeek.week,
        manager: manager,
        batter: playerName,
        status: 'Manual',
        ...stats,
        weekly_score: weeklyScore,
        total_score: Math.round((previousTotal + weeklyScore) * 100) / 100
      });

      // Auto-add player to roster for this week if not already rostered
      const weekKey = `${scheduleWeek.round}|${scheduleWeek.week}`;
      if (!sd.rosters) sd.rosters = {};
      if (!sd.rosters[manager]) sd.rosters[manager] = {};
      if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };
      if (!sd.rosters[manager][weekKey].batters.includes(playerName)) {
        sd.rosters[manager][weekKey].batters.push(playerName);
      }

      // Log as a swap entry so it appears in All Swaps
      if (!sd.swaps) sd.swaps = [];
      sd.swaps.push({
        id: Date.now().toString(),
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        email: COMMISSIONER_EMAIL || ROSTER_EMAIL || '',
        manager: manager,
        player_out: null,
        player_in: playerName,
        reason: 'Manual Update',
        swap_date: new Date().toISOString().split('T')[0],
        week_key: weekKey,
        status: 'approved',
      });

      saveSeason(SELECTED_SEASON, sd);
      document.getElementById('manual-update-status').innerHTML =
        `<p class="success-text">Saved batting stats for ${playerName} (${manager}) - ${scheduleWeek.label}. Score: ${fmt(weeklyScore)}</p>`;

    } else {
      if (!sd.weekly_pitching) sd.weekly_pitching = [];

      const stats = {
        gs: parseNum(document.getElementById('manual-gs').value),
        w: parseNum(document.getElementById('manual-w').value),
        qs: parseNum(document.getElementById('manual-qs').value),
        cg: parseNum(document.getElementById('manual-cg').value),
        cgso: parseNum(document.getElementById('manual-cgso').value),
        nh: parseNum(document.getElementById('manual-nh').value),
        ip: parseNum(document.getElementById('manual-ip').value),
        h: parseNum(document.getElementById('manual-h').value),
        er: parseNum(document.getElementById('manual-er').value),
        bb: parseNum(document.getElementById('manual-bb-pitch').value),
        k: parseNum(document.getElementById('manual-k').value),
      };

      const weeklyScore = calculatePitchingScore(stats);

      // Remove existing entry for same player/manager/week if any
      sd.weekly_pitching = sd.weekly_pitching.filter(p =>
        !(p.round === scheduleWeek.round && p.week === scheduleWeek.week && p.manager === manager && p.pitcher === playerName)
      );

      sd.weekly_pitching.push({
        round: scheduleWeek.round,
        week: scheduleWeek.week,
        manager: manager,
        pitcher: playerName,
        status: 'Manual',
        ...stats,
        weekly_score: weeklyScore
      });

      // Auto-add player to roster for this week if not already rostered
      const weekKeyP = `${scheduleWeek.round}|${scheduleWeek.week}`;
      if (!sd.rosters) sd.rosters = {};
      if (!sd.rosters[manager]) sd.rosters[manager] = {};
      if (!sd.rosters[manager][weekKeyP]) sd.rosters[manager][weekKeyP] = { batters: [], pitchers: [] };
      if (!sd.rosters[manager][weekKeyP].pitchers.includes(playerName)) {
        sd.rosters[manager][weekKeyP].pitchers.push(playerName);
      }

      // Log as a swap entry so it appears in All Swaps
      if (!sd.swaps) sd.swaps = [];
      sd.swaps.push({
        id: Date.now().toString(),
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        email: COMMISSIONER_EMAIL || ROSTER_EMAIL || '',
        manager: manager,
        player_out: null,
        player_in: playerName,
        reason: 'Manual Update',
        swap_date: new Date().toISOString().split('T')[0],
        week_key: weekKeyP,
        status: 'approved',
      });

      saveSeason(SELECTED_SEASON, sd);
      document.getElementById('manual-update-status').innerHTML =
        `<p class="success-text">Saved pitching stats for ${playerName} (${manager}) - ${scheduleWeek.label}. Score: ${fmt(weeklyScore)}</p>`;
    }

    // Clear form fields
    document.getElementById('manual-player-name').value = '';
    document.querySelectorAll('#manual-batting-fields input, #manual-pitching-fields input').forEach(input => {
      input.value = '0';
    });
    document.getElementById('manual-score-preview').innerHTML = '';

    // Refresh displays
    init();
  };

  // Initial population of player dropdown
  populateManualPlayerDropdown();
}

function calculateManualScore(type) {
  if (type === 'batting') {
    const stats = {
      '1b': parseNum(document.getElementById('manual-1b').value),
      '2b': parseNum(document.getElementById('manual-2b').value),
      '3b': parseNum(document.getElementById('manual-3b').value),
      hr: parseNum(document.getElementById('manual-hr').value),
      r: parseNum(document.getElementById('manual-r').value),
      rbi: parseNum(document.getElementById('manual-rbi').value),
      sb: parseNum(document.getElementById('manual-sb').value),
      bb: parseNum(document.getElementById('manual-bb-bat').value),
    };
    return calculateBattingScore(stats);
  } else {
    const stats = {
      w: parseNum(document.getElementById('manual-w').value),
      qs: parseNum(document.getElementById('manual-qs').value),
      cg: parseNum(document.getElementById('manual-cg').value),
      cgso: parseNum(document.getElementById('manual-cgso').value),
      nh: parseNum(document.getElementById('manual-nh').value),
      ip: parseNum(document.getElementById('manual-ip').value),
      h: parseNum(document.getElementById('manual-h').value),
      er: parseNum(document.getElementById('manual-er').value),
      bb: parseNum(document.getElementById('manual-bb-pitch').value),
      k: parseNum(document.getElementById('manual-k').value),
    };
    return calculatePitchingScore(stats);
  }
}

// ============================================================
// Commissioner Page
// ============================================================
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
  const mgr = managers.find(m => m.email && m.email.toLowerCase() === LOGGED_IN_EMAIL.toLowerCase() && m.commissioner);

  if (!mgr) {
    loginDiv.style.display = 'block';
    loginDiv.innerHTML = '<h2>Commissioner</h2><p>Your account does not have commissioner access.</p>';
    panelDiv.style.display = 'none';
    return;
  }

  COMMISSIONER_EMAIL = LOGGED_IN_EMAIL;
  localStorage.setItem('wmmc_commissioner_logged_in', LOGGED_IN_EMAIL);
  loginDiv.style.display = 'none';
  showCommissionerPanel();
}

function showCommissionerPanel() {
  document.getElementById('commissioner-login').style.display = 'none';
  document.getElementById('commissioner-panel').style.display = 'block';

  const managers = getManagers();
  const mgr = managers.find(m => m.email.toLowerCase() === COMMISSIONER_EMAIL);
  document.getElementById('commissioner-name').textContent = mgr ? mgr.name : COMMISSIONER_EMAIL;
  document.getElementById('season-setup-title').textContent = `${SELECTED_SEASON} Season Setup`;

  renderPendingSwapRequests();
  renderManagersTable();
  renderPlayerPoolDisplay();
  renderWeeklyUploadSections();
  setupPlayerPoolUploads();
  setupSeasonSetupToggle();
  setupASGDateInput();
  renderGSheetsConfig();
}

// ---- Pending Swap Requests (Commissioner Tab) ----
function renderPendingSwapRequests() {
  const container = document.getElementById('pending-swaps-list');
  if (!container) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || !sd.swaps) {
    container.innerHTML = '<p class="text-muted">No pending swap requests.</p>';
    return;
  }

  const pendingSwaps = sd.swaps.filter(s => s.status === 'pending');
  if (pendingSwaps.length === 0) {
    container.innerHTML = '<p class="text-muted">No pending swap requests.</p>';
    return;
  }

  let html = '';
  pendingSwaps.forEach(s => {
    html += `<div class="swap-pending-item" id="comm-swap-item-${s.id}">
      <div class="swap-pending-header">
        <strong>${s.manager || 'Unknown'}</strong>
        <span class="swap-badge swap-badge-pending">Pending</span>
      </div>
      <div class="swap-pending-details">
        <span>${s.player_out || '?'} &rarr; ${s.player_in || '?'}</span>
        <span class="swap-detail-reason">${s.reason || ''}</span>
        <span class="swap-detail-date">${s.swap_date || ''}</span>
      </div>
      <div class="swap-pending-actions" id="comm-swap-actions-${s.id}">
        <button class="btn btn-sm btn-success" onclick="approveSwap('${s.id}')">Approve</button>
        <button class="btn btn-sm btn-danger" onclick="denySwap('${s.id}')">Deny</button>
        <button class="btn btn-sm btn-secondary" onclick="viewSwapManager('${(s.manager || '').replace(/'/g, "\\'")}')">View Roster</button>
      </div>
    </div>`;
  });

  container.innerHTML = html;
}

// Navigate to a manager's roster page from commissioner pending swaps
window.viewSwapManager = function(managerName) {
  // Switch to My Roster tab and select this manager
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
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

  // Reset Season button
  const resetBtn = document.getElementById('reset-season-btn');
  const resetStatus = document.getElementById('reset-season-status');
  if (resetBtn) {
    resetBtn.onclick = () => {
      const confirmed = confirm(
        `Are you sure you want to reset all season data for ${SELECTED_SEASON}?\n\n` +
        'This will clear:\n' +
        '  - All player pools (batters & pitchers)\n' +
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

      saveSeason(SELECTED_SEASON, sd);
      if (resetStatus) resetStatus.innerHTML = '<p style="color:var(--success);font-weight:600;">Season data has been reset.</p>';
      init();
    };
  }
}

// ---- ASG Date Input ----
function setupASGDateInput() {
  const input = document.getElementById('asg-date-input');
  const btn = document.getElementById('asg-date-save-btn');
  const status = document.getElementById('asg-date-status');
  const preview = document.getElementById('schedule-dates-preview');
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

function renderScheduleDatesPreview() {
  const preview = document.getElementById('schedule-dates-preview');
  if (!preview) return;
  const dates = getScheduleDates();
  if (!dates || dates.length === 0) {
    preview.innerHTML = '<p style="color:#888;">No schedule dates set yet.</p>';
    return;
  }
  let html = '<table class="compact-table" style="width:100%;"><thead><tr><th>#</th><th>Round</th><th>Dates</th></tr></thead><tbody>';
  SEASON_SCHEDULE.forEach((s, i) => {
    const d = dates[i];
    if (!d) return;
    html += `<tr><td>${i + 1}</td><td>${s.label}</td><td>${fmtDateRangeShort(d.start, d.end)}</td></tr>`;
  });
  html += '</tbody></table>';
  preview.innerHTML = html;
}

// ---- Google Sheets Auto-Sync (Commissioner) ----

async function renderGSheetsConfig() {
  const statusDiv = document.getElementById('gsheets-status');
  const logDiv = document.getElementById('gsheets-sync-log');
  const urlInput = document.getElementById('gsheets-url');
  const apiKeyInput = document.getElementById('gsheets-api-key');
  const enabledCheckbox = document.getElementById('gsheets-enabled');
  if (!statusDiv || !urlInput) return;

  try {
    const [configResp, statusResp] = await Promise.all([
      fetch('/api/google-sheets/config'),
      fetch('/api/google-sheets/sync-status')
    ]);
    const config = await configResp.json();
    const syncStatus = await statusResp.json();

    // Populate form fields
    if (config.spreadsheet_id && !urlInput.value) {
      urlInput.value = config.spreadsheet_id;
    }
    if (config.api_key_masked && !apiKeyInput.value) {
      apiKeyInput.placeholder = config.api_key_masked;
    }
    enabledCheckbox.checked = config.enabled || false;

    // Show sync status
    let statusHtml = '';
    if (syncStatus.last_sync) {
      const syncDate = new Date(syncStatus.last_sync);
      const timeAgo = getTimeAgo(syncDate);
      const result = syncStatus.last_sync_result;

      if (result && result.success) {
        statusHtml += `<div class="gsheets-sync-status gsheets-sync-ok">
          <strong>Last sync:</strong> ${timeAgo} &mdash;
          ${result.batting_imported} batting, ${result.pitching_imported} pitching records imported
          (${result.weeks_with_data} weeks with data${result.errors > 0 ? `, ${result.errors} errors` : ''})
        </div>`;
      } else if (result) {
        statusHtml += `<div class="gsheets-sync-status gsheets-sync-err">
          <strong>Last sync failed:</strong> ${timeAgo} &mdash; ${result.error || 'Unknown error'}
        </div>`;
      }
    }

    if (syncStatus.enabled && syncStatus.next_sync) {
      const nextDate = new Date(syncStatus.next_sync);
      statusHtml += `<div class="gsheets-sync-status gsheets-sync-info">
        <strong>Next auto-sync:</strong> ${nextDate.toLocaleString()}
      </div>`;
    }

    statusDiv.innerHTML = statusHtml;

    // Show sync log from season's upload_log
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (sd && sd.upload_log) {
      const gsheetsLogs = sd.upload_log
        .filter(l => l.type === 'gsheets_sync')
        .slice(-5)
        .reverse();
      if (gsheetsLogs.length > 0) {
        let logHtml = '<h3 style="margin-bottom:0.5rem;">Recent Syncs</h3><div class="gsheets-log-list">';
        gsheetsLogs.forEach(l => {
          logHtml += `<div class="gsheets-log-item">
            <span class="gsheets-log-time">${l.timestamp}</span>
            <span>${l.batting_imported} bat, ${l.pitching_imported} pit records</span>
          </div>`;
        });
        logHtml += '</div>';
        logDiv.innerHTML = logHtml;
      }
    }
  } catch (e) {
    statusDiv.innerHTML = `<p class="text-muted">Could not load sync configuration.</p>`;
  }
}

function getTimeAgo(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

window.saveGSheetsConfig = async function() {
  const statusDiv = document.getElementById('gsheets-status');
  const urlInput = document.getElementById('gsheets-url');
  const apiKeyInput = document.getElementById('gsheets-api-key');
  const enabledCheckbox = document.getElementById('gsheets-enabled');

  const body = {
    spreadsheet_url: urlInput.value.trim(),
    enabled: enabledCheckbox.checked,
    season: SELECTED_SEASON
  };
  // Only send API key if the user typed a new one
  if (apiKeyInput.value.trim()) body.api_key = apiKeyInput.value.trim();

  try {
    statusDiv.innerHTML = '<p>Saving configuration...</p>';
    const resp = await fetch('/api/google-sheets/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">${data.error}</div>`;
      return;
    }
    statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-ok">Configuration saved. Spreadsheet ID: ${data.spreadsheet_id}</div>`;
    apiKeyInput.value = '';
    renderGSheetsConfig();
  } catch (e) {
    statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">Failed to save: ${e.message}</div>`;
  }
};

window.triggerGSheetsSync = async function() {
  const statusDiv = document.getElementById('gsheets-status');
  statusDiv.innerHTML = '<p>Syncing from Google Sheets... this may take a moment.</p>';

  try {
    const resp = await fetch('/api/google-sheets/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season: SELECTED_SEASON })
    });
    const data = await resp.json();
    if (!resp.ok) {
      statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">Sync failed: ${data.error}</div>`;
      return;
    }

    const r = data.result;
    statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-ok">
      Sync complete! ${r.batting_imported} batting, ${r.pitching_imported} pitching records.
      ${r.weeks_with_data} weeks with data${r.errors > 0 ? `, ${r.errors} errors` : ''}.
    </div>`;

    // Reload season data from server to pick up the synced stats
    await loadData();
    init();
  } catch (e) {
    statusDiv.innerHTML = `<div class="gsheets-sync-status gsheets-sync-err">Sync error: ${e.message}</div>`;
  }
};

// ---- Manager Management ----
let editingManagerIndex = -1;

function renderManagersTable() {
  const managers = getManagers();
  const table = document.getElementById('managers-table');

  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th><th>Email</th><th>Pool</th><th>Commissioner</th><th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${managers.map((m, i) => `
        <tr>
          <td><strong>${m.name}</strong></td>
          <td>${m.email}</td>
          <td>${m.pool ? 'Pool ' + m.pool : '-'}</td>
          <td>${m.commissioner ? '<span class="badge badge-winner">Yes</span>' : 'No'}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="editManager(${i})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteManager(${i})">Delete</button>
          </td>
        </tr>
      `).join('')}
    </tbody>
  `;

  document.getElementById('save-manager-btn').onclick = () => {
    const name = document.getElementById('mgr-name').value.trim();
    const email = document.getElementById('mgr-email').value.trim().toLowerCase();
    const isCommissioner = document.getElementById('mgr-commissioner').checked;
    const pool = parseInt(document.getElementById('mgr-pool').value) || null;

    if (!name || !email) {
      alert('Name and email are required.');
      return;
    }

    const managers = getManagers();

    if (editingManagerIndex >= 0) {
      managers[editingManagerIndex] = { name, email, commissioner: isCommissioner, pool };
      editingManagerIndex = -1;
      document.getElementById('cancel-edit-btn').style.display = 'none';
    } else {
      if (managers.find(m => m.email.toLowerCase() === email)) {
        alert('A manager with this email already exists.');
        return;
      }
      managers.push({ name, email, commissioner: isCommissioner, pool });
    }

    saveManagers(managers);
    document.getElementById('mgr-name').value = '';
    document.getElementById('mgr-email').value = '';
    document.getElementById('mgr-commissioner').checked = false;
    document.getElementById('mgr-pool').value = '';
    renderManagersTable();
  };

  document.getElementById('cancel-edit-btn').onclick = () => {
    editingManagerIndex = -1;
    document.getElementById('mgr-name').value = '';
    document.getElementById('mgr-email').value = '';
    document.getElementById('mgr-commissioner').checked = false;
    document.getElementById('mgr-pool').value = '';
    document.getElementById('cancel-edit-btn').style.display = 'none';
  };
}

window.editManager = function(index) {
  const managers = getManagers();
  const m = managers[index];
  document.getElementById('mgr-name').value = m.name;
  document.getElementById('mgr-email').value = m.email;
  document.getElementById('mgr-commissioner').checked = m.commissioner;
  document.getElementById('mgr-pool').value = m.pool || '';
  editingManagerIndex = index;
  document.getElementById('cancel-edit-btn').style.display = 'inline-block';
};

window.deleteManager = function(index) {
  if (!confirm('Are you sure you want to delete this manager?')) return;
  const managers = getManagers();
  managers.splice(index, 1);
  saveManagers(managers);
  renderManagersTable();
};

// Commissioner: open inline stat editor for a player
window.editPlayerStats = function(manager, statType, playerName, weekKey) {
  const [round, week] = weekKey.split('|');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const isBatting = statType === 'batting';
  const weeklyArr = isBatting ? (sd.weekly_batting || []) : (sd.weekly_pitching || []);
  const nameField = isBatting ? 'batter' : 'pitcher';
  const existing = weeklyArr.find(r => r[nameField] === playerName && r.manager === manager && r.round === round && r.week === week);

  // Build the edit dialog
  const dialogId = `stat-edit-dialog`;
  let dialog = document.getElementById(dialogId);
  if (dialog) dialog.remove();

  dialog = document.createElement('div');
  dialog.id = dialogId;
  dialog.className = 'stat-edit-overlay';

  const schedEntry = SEASON_SCHEDULE.find(s => s.round === round && s.week === week);
  const weekLabel = schedEntry ? schedEntry.label : `${round} - ${week}`;

  let fieldsHtml = '';
  if (isBatting) {
    const fields = [
      { key: 'abs', label: 'AB' }, { key: '1b', label: '1B' }, { key: '2b', label: '2B' },
      { key: '3b', label: '3B' }, { key: 'hr', label: 'HR' }, { key: 'r', label: 'R' },
      { key: 'rbi', label: 'RBI' }, { key: 'sb', label: 'SB' }, { key: 'bb', label: 'BB' }
    ];
    fields.forEach(f => {
      const val = existing ? (existing[f.key] || 0) : 0;
      const isManual = existing && (existing.manual_fields || []).includes(f.key);
      fieldsHtml += `<div class="stat-edit-field">
        <label${isManual ? ' class="stat-edit-manual-label"' : ''}>${f.label}${isManual ? ' *' : ''}</label>
        <input type="number" id="se-${f.key}" value="${val}" step="any" min="0">
      </div>`;
    });
  } else {
    const fields = [
      { key: 'gs', label: 'GS' }, { key: 'w', label: 'W' }, { key: 'qs', label: 'QS' },
      { key: 'cg', label: 'CG' }, { key: 'cgso', label: 'CGSO' }, { key: 'nh', label: 'NH' },
      { key: 'ip', label: 'IP' }, { key: 'h', label: 'H' }, { key: 'er', label: 'ER' },
      { key: 'bb', label: 'BB' }, { key: 'k', label: 'K' }
    ];
    fields.forEach(f => {
      const val = existing ? (existing[f.key] || 0) : 0;
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
      <button class="btn btn-primary" onclick="savePlayerStats('${manager.replace(/'/g, "\\'")}','${statType}','${playerName.replace(/'/g, "\\'")}','${weekKey}')">Save</button>
      <button class="btn btn-secondary" onclick="document.getElementById('${dialogId}').remove()">Cancel</button>
    </div>
  </div>`;

  document.body.appendChild(dialog);
};

// Commissioner: save edited stats for a player
window.savePlayerStats = function(manager, statType, playerName, weekKey) {
  const [round, week] = weekKey.split('|');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd) return;

  const isBatting = statType === 'batting';
  const nameField = isBatting ? 'batter' : 'pitcher';

  if (isBatting) {
    if (!sd.weekly_batting) sd.weekly_batting = [];
    const idx = sd.weekly_batting.findIndex(r => r[nameField] === playerName && r.manager === manager && r.round === round && r.week === week);
    const existing = idx >= 0 ? sd.weekly_batting[idx] : null;
    const prevManualFields = existing ? (existing.manual_fields || []) : [];

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
    statKeys.forEach(k => {
      const oldVal = existing ? (existing[k] || 0) : 0;
      if (newStats[k] !== oldVal) changedFields.add(k);
    });

    const weeklyScore = calculateBattingScore(newStats);

    const record = {
      round, week,
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
    sd.weekly_batting.forEach(b => { if (b.batter === playerName) total += (b.weekly_score || 0); });
    sd.weekly_batting.filter(b => b.batter === playerName).forEach(b => { b.total_score = Math.round(total * 100) / 100; });

  } else {
    if (!sd.weekly_pitching) sd.weekly_pitching = [];
    const idx = sd.weekly_pitching.findIndex(r => r[nameField] === playerName && r.manager === manager && r.round === round && r.week === week);
    const existing = idx >= 0 ? sd.weekly_pitching[idx] : null;
    const prevManualFields = existing ? (existing.manual_fields || []) : [];

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
    statKeys.forEach(k => {
      const oldVal = existing ? (existing[k] || 0) : 0;
      if (newStats[k] !== oldVal) changedFields.add(k);
    });

    const weeklyScore = calculatePitchingScore(newStats);

    const record = {
      round, week,
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
  const isComm = getManagers().some(m => m.email.toLowerCase() === (ROSTER_EMAIL || '').toLowerCase() && m.commissioner);
  renderRosterData(manager, isComm);
};

// Add a player to a specific week's roster for a manager
window.addToRoster = function(manager, type, selectId, weekKey) {
  const select = document.getElementById(selectId);
  const player = select.value;
  if (!player || !weekKey) return;

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.rosters) sd.rosters = {};
  if (!sd.rosters[manager]) sd.rosters[manager] = {};
  if (!sd.rosters[manager][weekKey]) sd.rosters[manager][weekKey] = { batters: [], pitchers: [] };

  const rosterKey = type;
  if (!sd.rosters[manager][weekKey][rosterKey].includes(player)) {
    sd.rosters[manager][weekKey][rosterKey].push(player);

    // Auto-assign any unattributed weekly stat records for this player+week
    const [round, week] = weekKey.split('|');
    const nameKey = rosterKey === 'batters' ? 'batter' : 'pitcher';
    const weeklyArr = rosterKey === 'batters' ? (sd.weekly_batting || []) : (sd.weekly_pitching || []);
    weeklyArr.forEach(rec => {
      if (rec[nameKey] === player && rec.round === round && rec.week === week && !rec.manager) {
        rec.manager = manager;
      }
    });

    // Create swap log entry for the add
    if (!sd.swaps) sd.swaps = [];
    sd.swaps.push({
      id: Date.now().toString(),
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      email: ROSTER_EMAIL || COMMISSIONER_EMAIL || '',
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
window.removeFromRoster = function(manager, type, player, weekKey) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.rosters || !sd.rosters[manager] || !sd.rosters[manager][weekKey]) return;

  sd.rosters[manager][weekKey][type] = (sd.rosters[manager][weekKey][type] || []).filter(p => p !== player);

  // Create swap log entry for the drop
  if (!sd.swaps) sd.swaps = [];
  sd.swaps.push({
    id: Date.now().toString(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    email: ROSTER_EMAIL || COMMISSIONER_EMAIL || '',
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

// ---- Player Pool Upload ----
function setupPlayerPoolUploads() {
  document.getElementById('upload-batters-pool-btn').onclick = () => {
    const fileInput = document.getElementById('upload-batters-pool');
    if (!fileInput.files[0]) { alert('Select a file first.'); return; }
    parseCSVFile(fileInput.files[0], (names) => {
      const seasons = getSeasons();
      const sd = seasons[SELECTED_SEASON];
      sd.batters_pool = names;
      saveSeason(SELECTED_SEASON, sd);
      document.getElementById('player-pool-status').innerHTML =
        `<p class="success-text">Uploaded ${names.length} batters to the pool.</p>`;
      renderPlayerPoolDisplay();
      fileInput.value = '';
    });
  };

  document.getElementById('upload-pitchers-pool-btn').onclick = () => {
    const fileInput = document.getElementById('upload-pitchers-pool');
    if (!fileInput.files[0]) { alert('Select a file first.'); return; }
    parseCSVFile(fileInput.files[0], (names) => {
      const seasons = getSeasons();
      const sd = seasons[SELECTED_SEASON];
      sd.pitchers_pool = names;
      saveSeason(SELECTED_SEASON, sd);
      document.getElementById('player-pool-status').innerHTML =
        `<p class="success-text">Uploaded ${names.length} pitchers to the pool.</p>`;
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
    html += '<div class="pool-list">' + batters.map(n => `<span class="pool-tag">${n}</span>`).join('') + '</div>';
  } else {
    html += '<p class="text-muted">No batters uploaded yet.</p>';
  }
  html += '</div>';

  html += '<div>';
  html += `<h3>Pitchers Pool (${pitchers.length})</h3>`;
  if (pitchers.length > 0) {
    html += '<div class="pool-list">' + pitchers.map(n => `<span class="pool-tag">${n}</span>`).join('') + '</div>';
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
    sd.weekly_batting.forEach(b => {
      if (b.batter === playerName && !b.manager) {
        b.manager = managerName;
        changed = true;
      }
    });
  }

  if (!isBatter && sd.weekly_pitching) {
    sd.weekly_pitching.forEach(p => {
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
  batting.forEach(b => uploadedBatting.add(`${b.round}|${b.week}`));
  pitching.forEach(p => uploadedPitching.add(`${p.round}|${p.week}`));

  const dates = getScheduleDates();
  let html = '';
  SEASON_SCHEDULE.forEach((s, i) => {
    const weekKey = `${s.round}|${s.week}`;
    const hasBatting = uploadedBatting.has(weekKey);
    const hasPitching = uploadedPitching.has(weekKey);
    const isComplete = hasBatting && hasPitching;
    const dateStr = dates && dates[i] ? fmtDateRangeShort(dates[i].start, dates[i].end) : '';

    // Check if this week has a prior week for Advance Players
    const hasPriorWeek = i > 0;

    html += `
      <div class="weekly-upload-block ${isComplete ? 'upload-complete' : ''}">
        <div class="weekly-upload-header">
          <h3>${s.label}${dateStr ? ` <span class="week-dates-inline">(${dateStr})</span>` : ''}</h3>
          <span class="badge ${isComplete ? 'badge-winner' : 'badge-wildcard'}">${isComplete ? 'Complete' : 'Pending'}</span>
        </div>`;

    // Advance Players button (not for the first week)
    if (hasPriorWeek) {
      html += `<div style="margin:0.5rem 0;">
        <button class="btn btn-sm btn-secondary" onclick="advancePlayers(${i})">Advance Players</button>
        <span class="text-muted" style="font-size:0.78rem;">Copy rosters from ${SEASON_SCHEDULE[i - 1].label}</span>
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

    // Upload log for this week
    const weekLogs = uploadLog.filter(l => l.round === s.round && l.week === s.week);
    if (weekLogs.length > 0) {
      html += '<div class="upload-log">';
      html += '<div class="upload-log-label">Upload History</div>';
      weekLogs.forEach(l => {
        html += `<div class="upload-log-entry">
          <span class="upload-log-time">${l.timestamp}</span>
          <span class="upload-log-type">${l.type}</span>
          <span class="upload-log-detail">${l.assigned} assigned, ${l.unassigned} unassigned (${l.rows} total rows)</span>
        </div>`;
      });
      html += '</div>';
    }

    html += `</div>`;
  });

  container.innerHTML = html;
}

// Advance Players: copy per-week rosters from prior week to current week for all managers
window.advancePlayers = function(weekIndex) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd || weekIndex < 1) return;

  migrateRostersToWeekly(sd);

  const priorSched = SEASON_SCHEDULE[weekIndex - 1];
  const currentSched = SEASON_SCHEDULE[weekIndex];
  const priorKey = `${priorSched.round}|${priorSched.week}`;
  const currentKey = `${currentSched.round}|${currentSched.week}`;

  if (!sd.rosters) sd.rosters = {};
  let advanced = 0;

  const managers = getManagers();
  managers.forEach(m => {
    if (!sd.rosters[m.name]) sd.rosters[m.name] = {};
    const priorRoster = sd.rosters[m.name][priorKey];
    if (priorRoster) {
      // Copy prior week's roster to current week (don't overwrite existing)
      if (!sd.rosters[m.name][currentKey]) {
        sd.rosters[m.name][currentKey] = {
          batters: [...(priorRoster.batters || [])],
          pitchers: [...(priorRoster.pitchers || [])]
        };
        advanced++;
      }
    }
  });

  saveSeason(SELECTED_SEASON, sd);

  const statusEl = document.getElementById(`advance-status-${weekIndex}`);
  if (statusEl) {
    statusEl.innerHTML = advanced > 0
      ? `<span class="success-text" style="font-size:0.78rem;"> Advanced ${advanced} manager roster${advanced > 1 ? 's' : ''}.</span>`
      : `<span class="text-muted" style="font-size:0.78rem;"> All rosters already set for this week.</span>`;
  }
  renderWeeklyUploadSections();
};

window.uploadWeeklyBatting = function(weekIndex) {
  const scheduleWeek = SEASON_SCHEDULE[weekIndex];
  const fileInput = document.getElementById(`upload-bat-${weekIndex}`);
  if (!fileInput.files[0]) { alert('Select a file first.'); return; }

  parseCSVFileWithStats(fileInput.files[0], (rows) => {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd.weekly_batting) sd.weekly_batting = [];

    // Preserve records that have manually edited fields
    const manualBatRecords = sd.weekly_batting.filter(b =>
      b.round === scheduleWeek.round && b.week === scheduleWeek.week && b.manual_fields && b.manual_fields.length > 0
    );
    const manualBatKeys = new Set(manualBatRecords.map(b => `${b.manager}|${b.batter}`));

    sd.weekly_batting = sd.weekly_batting.filter(b =>
      !(b.round === scheduleWeek.round && b.week === scheduleWeek.week) ||
      (b.manual_fields && b.manual_fields.length > 0)
    );

    const batterTotals = {};
    sd.weekly_batting.forEach(b => {
      if (!batterTotals[b.batter]) batterTotals[b.batter] = 0;
      batterTotals[b.batter] += (b.weekly_score || 0);
    });

    let imported = 0;
    let skipped = 0;
    rows.forEach(row => {
      const batter = findColumn(row, ['batter', 'player', 'name']);
      if (!batter) return;

      // Resolve manager: use week-specific roster lookup first, then fallback
      let manager = findManagerForPlayerWeek(sd, batter, 'batting', scheduleWeek.round, scheduleWeek.week);
      if (!manager) manager = findManagerForPlayer(sd, batter, 'batting');
      if (!manager) manager = findColumn(row, ['manager', 'owner']);
      const isUnassigned = !manager;

      const stats = {
        '1b': parseNum(row['1b'] || row['1B'] || row['singles'] || 0),
        '2b': parseNum(row['2b'] || row['2B'] || row['doubles'] || 0),
        '3b': parseNum(row['3b'] || row['3B'] || row['triples'] || 0),
        hr: parseNum(row['hr'] || row['HR'] || row['home_runs'] || row['homeRuns'] || 0),
        r: parseNum(row['r'] || row['R'] || row['runs'] || 0),
        rbi: parseNum(row['rbi'] || row['RBI'] || 0),
        sb: parseNum(row['sb'] || row['SB'] || row['stolen_bases'] || row['stolenBases'] || 0),
        bb: parseNum(row['bb'] || row['BB'] || row['walks'] || 0),
        abs: parseNum(row['ab'] || row['AB'] || row['abs'] || row['atBats'] || 0),
      };

      // Check if this player has a manually-edited record for this week
      const manualKey = `${manager || null}|${batter}`;
      const manualRecord = manualBatRecords.find(m => m.batter === batter && m.manager === (manager || null));
      if (manualRecord) {
        // Merge: keep manual fields from existing record, use upload for non-manual fields
        const manualFields = manualRecord.manual_fields || [];
        const statKeys = ['abs', '1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb'];
        statKeys.forEach(k => {
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
        total_score: Math.round((previousTotal + weeklyScore) * 100) / 100
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
      unassigned: skipped
    });

    saveSeason(SELECTED_SEASON, sd);
    let statusMsg = `Uploaded ${imported} batter records. Scores calculated.`;
    if (skipped > 0) statusMsg += ` ${skipped} players unrostered (stats stored, will be assigned when added to a roster).`;
    document.getElementById(`upload-status-${weekIndex}`).innerHTML =
      `<p class="success-text">${statusMsg}</p>`;
    renderWeeklyUploadSections();
    fileInput.value = '';
    init();
  });
};

window.uploadWeeklyPitching = function(weekIndex) {
  const scheduleWeek = SEASON_SCHEDULE[weekIndex];
  const fileInput = document.getElementById(`upload-pit-${weekIndex}`);
  if (!fileInput.files[0]) { alert('Select a file first.'); return; }

  parseCSVFileWithStats(fileInput.files[0], (rows) => {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd.weekly_pitching) sd.weekly_pitching = [];

    // Preserve records that have manually edited fields
    const manualPitRecords = sd.weekly_pitching.filter(p =>
      p.round === scheduleWeek.round && p.week === scheduleWeek.week && p.manual_fields && p.manual_fields.length > 0
    );

    sd.weekly_pitching = sd.weekly_pitching.filter(p =>
      !(p.round === scheduleWeek.round && p.week === scheduleWeek.week) ||
      (p.manual_fields && p.manual_fields.length > 0)
    );

    let imported = 0;
    let skipped = 0;
    rows.forEach(row => {
      const pitcher = findColumn(row, ['pitcher', 'player', 'name']);
      if (!pitcher) return;

      // Resolve manager: use week-specific roster lookup first, then fallback
      let manager = findManagerForPlayerWeek(sd, pitcher, 'pitching', scheduleWeek.round, scheduleWeek.week);
      if (!manager) manager = findManagerForPlayer(sd, pitcher, 'pitching');
      if (!manager) manager = findColumn(row, ['manager', 'owner']);
      const isUnassigned = !manager;

      const stats = {
        gs: parseNum(row['gs'] || row['GS'] || 0),
        w: parseNum(row['w'] || row['W'] || row['wins'] || 0),
        qs: parseNum(row['qs'] || row['QS'] || 0),
        cg: parseNum(row['cg'] || row['CG'] || 0),
        cgso: parseNum(row['cgso'] || row['CGSO'] || 0),
        nh: parseNum(row['nh'] || row['NH'] || 0),
        ip: parseNum(row['ip'] || row['IP'] || 0),
        h: parseNum(row['h'] || row['H'] || row['hits'] || 0),
        er: parseNum(row['er'] || row['ER'] || 0),
        bb: parseNum(row['bb'] || row['BB'] || row['walks'] || 0),
        k: parseNum(row['k'] || row['K'] || row['so'] || row['SO'] || row['strikeouts'] || 0),
      };

      // Check if this player has a manually-edited record for this week
      const manualRecord = manualPitRecords.find(m => m.pitcher === pitcher && m.manager === (manager || null));
      if (manualRecord) {
        // Merge: keep manual fields from existing record, use upload for non-manual fields
        const manualFields = manualRecord.manual_fields || [];
        const statKeys = ['gs', 'w', 'qs', 'cg', 'cgso', 'nh', 'ip', 'h', 'er', 'bb', 'k'];
        statKeys.forEach(k => {
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
        weekly_score: weeklyScore
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
      unassigned: skipped
    });

    saveSeason(SELECTED_SEASON, sd);
    let statusMsg = `Uploaded ${imported} pitcher records. Scores calculated.`;
    if (skipped > 0) statusMsg += ` ${skipped} players unrostered (stats stored, will be assigned when added to a roster).`;
    document.getElementById(`upload-status-${weekIndex}`).innerHTML =
      `<p class="success-text">${statusMsg}</p>`;
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
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV file appears empty.'); return; }

    const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const nameCol = headers.findIndex(h =>
      h === 'name' || h === 'player' || h === 'player_name' || h === 'playername' || h === 'batter' || h === 'pitcher'
    );

    if (nameCol === -1) {
      const names = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols[0] && cols[0].trim()) names.push(cols[0].trim());
      }
      callback(names);
      return;
    }

    const names = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols[nameCol] && cols[nameCol].trim()) names.push(cols[nameCol].trim());
    }
    callback(names);
  };
  reader.readAsText(file);
}

function parseCSVFileWithStats(file, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV file appears empty.'); return; }

    const headers = parseCSVLine(lines[0]).map(h => h.trim());
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

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function findColumn(row, possibleNames) {
  for (const name of possibleNames) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === name.toLowerCase()) return row[key];
    }
  }
  return null;
}

function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ============================================================
// Helpers
// ============================================================
function fmt(val) {
  if (val == null || val === '' || val === 'None') return '-';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  return num % 1 === 0 ? num.toLocaleString() : num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function fmtDec(val) {
  if (val == null || val === '') return '0';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  options.forEach(opt => {
    if (opt) {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = (labelMap && labelMap[opt]) ? labelMap[opt] : opt;
      select.appendChild(el);
    }
  });
  if ([...select.options].some(o => o.value === current)) {
    select.value = current;
  }
}

// Load and start
loadData();
