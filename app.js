// ============================================================
// WMMC - The Whit Merrifield Memorial Cup
// Multi-season app with Commissioner management
// ============================================================

let DATA = null;           // Data for the currently viewed season
let CURRENT_YEAR = new Date().getFullYear();
let SELECTED_SEASON = null;
let COMMISSIONER_EMAIL = null;

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
// localStorage helpers
// ============================================================
function getSeasons() {
  return JSON.parse(localStorage.getItem('wmmc_seasons') || '{}');
}
function saveSeason(year, data) {
  const seasons = getSeasons();
  seasons[year] = data;
  localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
}
function getManagers() {
  return JSON.parse(localStorage.getItem('wmmc_managers') || '[]');
}
function saveManagers(managers) {
  localStorage.setItem('wmmc_managers', JSON.stringify(managers));
}

// ============================================================
// Initialization
// ============================================================
async function loadData() {
  // Ensure we always have 2025 as a historical season
  const seasons = getSeasons();
  if (!seasons['2025']) {
    try {
      const resp = await fetch('data.json');
      const legacy = await resp.json();
      seasons['2025'] = { status: 'completed', data: legacy };
      localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
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
    // Add Edgar Rivas if missing (he's in the data but may not have email)
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
  }

  document.getElementById('footer-year').textContent = CURRENT_YEAR;

  buildSeasonSelector();
  init();
}

function buildSeasonSelector() {
  const seasons = getSeasons();
  const select = document.getElementById('season-select');
  select.innerHTML = '';

  // Sort years descending
  const years = Object.keys(seasons).sort((a, b) => b - a);
  years.forEach(year => {
    const opt = document.createElement('option');
    opt.value = year;
    const status = seasons[year].status === 'active' ? ' (Active)' : ' (Completed)';
    opt.textContent = year + status;
    select.appendChild(opt);
  });

  // Default to current year
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

  if (seasonData.status === 'completed' && seasonData.data) {
    // Historical season - use the legacy data format
    DATA = seasonData.data;
    showHistoricalSeason();
  } else {
    // Active season - use the new data format
    DATA = null;
    showActiveSeason(seasonData);
  }

  setupNav();
  renderSchedule();
  renderCommissioner();
  renderRulesFromScoring();
}

// ============================================================
// Navigation
// ============================================================
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

// ============================================================
// Historical Season (2025 completed)
// ============================================================
function showHistoricalSeason() {
  renderDashboard();
  renderStandings();
  renderWeekly();
  renderPlayers();
  renderBracket();
  renderSwaps();
}

function renderDashboard() {
  const banner = document.getElementById('champion-banner');
  const grid = document.getElementById('stats-grid');
  const table = document.getElementById('final-standings-table');

  if (!DATA || !DATA.bracket || !DATA.bracket.finals) {
    banner.innerHTML = `<div class="trophy">&#127942;</div>
      <div class="champion-label">${SELECTED_SEASON} WMMC Season</div>
      <div class="champion-name">Season In Progress</div>`;
    grid.innerHTML = '';
    table.innerHTML = '<tbody><tr><td>No final standings yet.</td></tr></tbody>';
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

  const poolPlay = [...DATA.scoreboard.pool_play].sort((a, b) => a.overall_rank - b.overall_rank);
  table.innerHTML = `
    <thead>
      <tr>
        <th>Rank</th><th>Manager</th><th>Pool</th>
        <th>PP1 Total</th><th>PP2 Total</th>
        <th>Batting</th><th>Pitching</th><th>PP Total</th>
      </tr>
    </thead>
    <tbody>
      ${poolPlay.map(p => {
        const pool = getPool(p.manager);
        const rankClass = p.overall_rank <= 3 ? `rank-${p.overall_rank}` : '';
        return `<tr>
          <td class="rank ${rankClass}">${p.overall_rank}</td>
          <td><strong>${p.manager}</strong></td>
          <td>${pool}</td>
          <td class="num">${fmt(p.pp1_total)}</td>
          <td class="num">${fmt(p.pp2_total)}</td>
          <td class="num">${fmt(p.batting_total)}</td>
          <td class="num">${fmt(p.pitching_total)}</td>
          <td class="num"><strong>${fmt(p.pp_total)}</strong></td>
        </tr>`;
      }).join('')}
    </tbody>
  `;
}

function renderStandings() {
  if (!DATA || !DATA.scoreboard) return;

  const poolBtns = document.querySelectorAll('.pool-btn');
  poolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      poolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPoolTable(btn.dataset.pool);
    });
  });
  renderPoolTable('all');
  renderQualifiers();
  renderAwards();
}

function renderPoolTable(poolFilter) {
  const table = document.getElementById('pool-play-table');
  if (!DATA || !DATA.scoreboard) { table.innerHTML = ''; return; }

  let entries = DATA.scoreboard.pool_play;
  if (poolFilter !== 'all') {
    const poolMembers = DATA.scoreboard.pools[poolFilter];
    entries = entries.filter(p => poolMembers.includes(p.manager));
  }
  entries = [...entries].sort((a, b) => {
    if (poolFilter !== 'all') return a.pool_rank - b.pool_rank;
    return a.overall_rank - b.overall_rank;
  });

  table.innerHTML = `
    <thead>
      <tr>
        <th>${poolFilter !== 'all' ? 'Pool Rank' : 'Overall Rank'}</th>
        <th>Manager</th><th>Pool</th>
        <th>PP1 Bat</th><th>PP1 Pitch</th><th>PP1 Total</th>
        <th>PP2 Bat</th><th>PP2 Pitch</th><th>PP2 Total</th>
        <th>Total Bat</th><th>Total Pitch</th><th>PP Total</th>
      </tr>
    </thead>
    <tbody>
      ${entries.map(p => {
        const pool = getPool(p.manager);
        const rank = poolFilter !== 'all' ? p.pool_rank : p.overall_rank;
        return `<tr>
          <td class="rank">${rank}</td>
          <td><strong>${p.manager}</strong></td>
          <td>${pool}</td>
          <td class="num">${fmt(p.pp1_batting)}</td>
          <td class="num">${fmt(p.pp1_pitching)}</td>
          <td class="num">${fmt(p.pp1_total)}</td>
          <td class="num">${fmt(p.pp2_batting)}</td>
          <td class="num">${fmt(p.pp2_pitching)}</td>
          <td class="num">${fmt(p.pp2_total)}</td>
          <td class="num">${fmt(p.batting_total)}</td>
          <td class="num">${fmt(p.pitching_total)}</td>
          <td class="num"><strong>${fmt(p.pp_total)}</strong></td>
        </tr>`;
      }).join('')}
    </tbody>
  `;
}

function renderQualifiers() {
  const container = document.getElementById('qualifiers-list');
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.wildcards) { container.innerHTML = ''; return; }

  const wildcards = DATA.scoreboard.wildcards;
  const qualifiedAsWinner = new Set();
  // Determine pool winners from pool_play data
  if (DATA.scoreboard.pools) {
    for (const [, members] of Object.entries(DATA.scoreboard.pools)) {
      const poolEntries = DATA.scoreboard.pool_play.filter(p => members.includes(p.manager));
      const sorted = [...poolEntries].sort((a, b) => a.pool_rank - b.pool_rank);
      if (sorted.length > 0) qualifiedAsWinner.add(sorted[0].manager);
    }
  }

  const top8 = wildcards.filter(w => w.overall_rank <= 8);
  container.innerHTML = top8.map(w => {
    const isWinner = qualifiedAsWinner.has(w.manager);
    const badgeClass = isWinner ? 'badge-winner' : 'badge-wildcard';
    const badgeText = isWinner ? 'Pool Winner' : 'Wildcard';
    return `
      <div class="qualifier-item">
        <div class="qualifier-badge">
          <strong>#${w.overall_rank}</strong>
          <span>${w.manager}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <span class="num">${fmt(w.overall_score)}</span>
      </div>
    `;
  }).join('');
}

function renderAwards() {
  const container = document.getElementById('awards-list');
  if (!DATA || !DATA.scoreboard || !DATA.scoreboard.stats) { container.innerHTML = ''; return; }

  const stats = DATA.scoreboard.stats;
  const awards = [
    { label: 'Best PP1 Batting', ...stats.pp1.best_batting },
    { label: 'Best PP1 Pitching', ...stats.pp1.best_pitching },
    { label: 'Best PP2 Batting', ...stats.pp2.best_batting },
    { label: 'Best PP2 Pitching', ...stats.pp2.best_pitching },
    { label: 'Best Overall Batting', ...stats.overall.best_batting },
    { label: 'Best Overall Pitching', ...stats.overall.best_pitching },
    { label: 'Best Single Round', ...stats.overall.best_round },
    { label: 'Best QF Batting', ...stats.quarterfinal.best_batting },
    { label: 'Best QF Total', ...stats.quarterfinal.best_total },
    { label: 'Best SF Batting', ...stats.semifinal.best_batting },
    { label: 'Best SF Total', ...stats.semifinal.best_total },
  ];

  container.innerHTML = awards.map(a => `
    <div class="award-item">
      <div class="award-label">${a.label}</div>
      <div class="award-value">
        <div class="award-manager">${a.manager}</div>
        <div class="award-score">${fmt(a.score)}</div>
      </div>
    </div>
  `).join('');
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

    const table = document.getElementById('weekly-table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Round</th><th>Week</th><th>Manager</th><th>Pool</th>
          <th>Batting</th><th>Bat Rank</th>
          <th>Pitching</th><th>Pitch Rank</th>
          <th>Total</th><th>Total Rank</th>
          <th>Cumul. Batting</th><th>Cumul. Pitching</th><th>Cumul. Total</th>
          <th>Pool Rank</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(t => `
          <tr>
            <td>${t.round || ''}</td>
            <td>${t.week || ''}</td>
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
        `).join('')}
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
    btn.onclick = () => {
      typeBtns.forEach(b => b.classList.remove('active'));
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

    if (currentType === 'batting') {
      let filtered = DATA.batting_weekly;
      if (roundF !== 'all') filtered = filtered.filter(b => b.round === roundF);
      if (weekF !== 'all') filtered = filtered.filter(b => b.week === weekF);
      if (managerF !== 'all') filtered = filtered.filter(b => b.manager === managerF);

      table.innerHTML = `
        <thead>
          <tr>
            <th>Week</th><th>Manager</th><th>Batter</th><th>Status</th>
            <th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th>
            <th>R</th><th>RBI</th><th>SB</th><th>BB</th>
            <th>Week Pts</th><th>Total Pts</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(b => `
            <tr>
              <td>${b.week || ''}</td>
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
          `).join('')}
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
            <th>Week</th><th>Manager</th><th>Pitcher</th><th>Status</th>
            <th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th>
            <th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th>
            <th>Week Pts</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(p => `
            <tr>
              <td>${p.week || ''}</td>
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
          `).join('')}
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
  const container = document.getElementById('bracket-container');
  if (!DATA || !DATA.bracket) {
    container.innerHTML = '<p>No bracket data available for this season.</p>';
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

  container.innerHTML = `
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
  `;
}

// ---- Swaps ----
function renderSwaps() {
  if (!DATA || !DATA.swaps) {
    document.getElementById('swaps-table').innerHTML = '<tbody><tr><td>No transaction data available for this season.</td></tr></tbody>';
    return;
  }

  const managers = [...new Set(DATA.swaps.map(s => {
    return DATA.email_map[s.email] || s.email;
  }))].sort();
  resetSelect('swap-manager-filter', managers);

  const update = () => {
    const typeF = document.getElementById('swap-type-filter').value;
    const managerF = document.getElementById('swap-manager-filter').value;

    let filtered = DATA.swaps.map(s => ({
      ...s,
      manager: DATA.email_map[s.email] || s.email,
    }));

    if (typeF !== 'all') filtered = filtered.filter(s => s.reason === typeF);
    if (managerF !== 'all') filtered = filtered.filter(s => s.manager === managerF);
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const table = document.getElementById('swaps-table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Date</th><th>Manager</th><th>Type</th>
          <th>Player Out</th><th>Player In</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(s => {
          const typeClass = s.reason.includes('Free') ? 'swap-free' :
                           s.reason.includes('IL') ? 'swap-il' :
                           s.reason.includes('Drop') ? 'swap-drop' : 'swap-trade';
          const typeLabel = s.reason.includes('Free') ? 'Free Swap' :
                           s.reason.includes('IL') ? 'IL Swap' :
                           s.reason.includes('Drop') ? 'Drop Swap' : 'Trade Swap';
          return `
            <tr>
              <td>${formatDate(s.timestamp)}</td>
              <td><strong>${s.manager}</strong></td>
              <td><span class="swap-type ${typeClass}">${typeLabel}</span></td>
              <td class="player-out">${s.player_out || ''}</td>
              <td class="player-in">${s.player_in || ''}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    `;
  };

  document.getElementById('swap-type-filter').onchange = update;
  document.getElementById('swap-manager-filter').onchange = update;
  update();
}

// ---- Rules ----
function renderRulesFromScoring() {
  // Always render the scoring tables from the constant SCORING
  const batTable = document.getElementById('batting-scoring-table');
  const pitchTable = document.getElementById('pitching-scoring-table');

  batTable.innerHTML = `
    <thead><tr><th>Category</th><th>Points</th></tr></thead>
    <tbody>
      ${Object.entries(SCORING.batting).map(([k, v]) =>
        `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`
      ).join('')}
    </tbody>
  `;

  pitchTable.innerHTML = `
    <thead><tr><th>Category</th><th>Points</th></tr></thead>
    <tbody>
      ${Object.entries(SCORING.pitching).map(([k, v]) =>
        `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`
      ).join('')}
    </tbody>
  `;

  // Render rules text if available
  const container = document.getElementById('rules-content');
  if (DATA && DATA.rules_text) {
    const headings = ['Purpose', 'Format', 'Player Selection', 'Schedule', 'Pool Play', 'Elimination Play', 'Scoring'];
    let html = '';
    for (const line of DATA.rules_text) {
      if (line === 'The Whit Merrifield Memorial Cup') continue;
      if (headings.includes(line)) {
        html += `<p class="rule-heading">${line}</p>`;
      } else {
        html += `<p>${line}</p>`;
      }
    }
    container.innerHTML = html;
  } else {
    container.innerHTML = '<p>Rules are defined in the Constitution. See scoring tables below.</p>';
  }
}

// ============================================================
// Active Season Display
// ============================================================
function showActiveSeason(seasonData) {
  const banner = document.getElementById('champion-banner');
  banner.innerHTML = `
    <div class="trophy">&#9918;</div>
    <div class="champion-label">${SELECTED_SEASON} WMMC Season</div>
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
      { label: 'Active Managers', value: managers.length, detail: '' },
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

  // Standings table for active season
  const table = document.getElementById('final-standings-table');
  if (managerScores.length > 0) {
    const sorted = [...managerScores].sort((a, b) => b.total - a.total);
    table.innerHTML = `
      <thead>
        <tr>
          <th>Rank</th><th>Manager</th>
          <th>Batting</th><th>Pitching</th><th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((m, i) => `
          <tr>
            <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
            <td><strong>${m.manager}</strong></td>
            <td class="num">${fmt(m.batting)}</td>
            <td class="num">${fmt(m.pitching)}</td>
            <td class="num"><strong>${fmt(m.total)}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    `;
  } else {
    table.innerHTML = '<tbody><tr><td>No scoring data yet. Upload weekly stats to see standings.</td></tr></tbody>';
  }

  // Render active season weekly/player data
  renderActiveWeekly(seasonData);
  renderActivePlayers(seasonData);

  // Clear historical-only sections
  document.getElementById('pool-play-table').innerHTML = '';
  document.getElementById('qualifiers-list').innerHTML = '';
  document.getElementById('awards-list').innerHTML = '';
  document.getElementById('bracket-container').innerHTML = '<p>Bracket will be available during playoff rounds.</p>';
  document.getElementById('swaps-table').innerHTML = '';
}

function renderActiveWeekly(seasonData) {
  const teamWeekly = buildTeamWeekly(seasonData);
  if (teamWeekly.length === 0) {
    document.getElementById('weekly-table').innerHTML = '<tbody><tr><td>No weekly data yet.</td></tr></tbody>';
    return;
  }

  // Temporarily set DATA so the existing renderWeekly can work
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

  const origData = DATA;
  DATA = { batting_weekly: batting, pitching_weekly: pitching };
  renderPlayers();
  DATA = origData;
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

function computeManagerScores(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const managerMap = {};
  batting.forEach(b => {
    if (!managerMap[b.manager]) managerMap[b.manager] = { manager: b.manager, batting: 0, pitching: 0, total: 0 };
    managerMap[b.manager].batting += (b.weekly_score || 0);
  });
  pitching.forEach(p => {
    if (!managerMap[p.manager]) managerMap[p.manager] = { manager: p.manager, batting: 0, pitching: 0, total: 0 };
    managerMap[p.manager].pitching += (p.weekly_score || 0);
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

  // Group by manager + round + week
  const key = (r, w, m) => `${r}|${w}|${m}`;
  const map = {};

  batting.forEach(b => {
    const k = key(b.round, b.week, b.manager);
    if (!map[k]) map[k] = { round: b.round, week: b.week, manager: b.manager, pool: '', weekly_batting: 0, weekly_pitching: 0, weekly_total: 0 };
    map[k].weekly_batting += (b.weekly_score || 0);
  });

  pitching.forEach(p => {
    const k = key(p.round, p.week, p.manager);
    if (!map[k]) map[k] = { round: p.round, week: p.week, manager: p.manager, pool: '', weekly_batting: 0, weekly_pitching: 0, weekly_total: 0 };
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
function renderSchedule() {
  const container = document.getElementById('schedule-content');
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];

  if (!seasonData) { container.innerHTML = ''; return; }

  const isActive = seasonData.status === 'active';

  let html = `<div class="card"><h2>${SELECTED_SEASON} Season Schedule</h2>`;

  if (!isActive && seasonData.data && seasonData.data.team_weekly) {
    // Historical: show which weeks had data
    const weekSet = new Set(seasonData.data.team_weekly.map(t => `${t.round}|${t.week}`));
    html += '<div class="schedule-grid">';
    SEASON_SCHEDULE.forEach((s, i) => {
      const hasData = weekSet.has(`${s.round}|${s.week}`);
      html += `
        <div class="schedule-week ${hasData ? 'schedule-completed' : 'schedule-empty'}">
          <div class="schedule-week-num">Week ${i + 1}</div>
          <div class="schedule-week-label">${s.label}</div>
          <div class="schedule-week-status">${hasData ? 'Completed' : 'No Data'}</div>
        </div>
      `;
    });
    html += '</div>';
  } else if (isActive) {
    const batting = seasonData.weekly_batting || [];
    const uploadedWeeks = new Set();
    batting.forEach(b => uploadedWeeks.add(`${b.round}|${b.week}`));

    html += '<div class="schedule-grid">';
    SEASON_SCHEDULE.forEach((s, i) => {
      const hasData = uploadedWeeks.has(`${s.round}|${s.week}`);
      html += `
        <div class="schedule-week ${hasData ? 'schedule-completed' : 'schedule-pending'}">
          <div class="schedule-week-num">Week ${i + 1}</div>
          <div class="schedule-week-label">${s.label}</div>
          <div class="schedule-week-status">${hasData ? 'Stats Uploaded' : 'Pending'}</div>
        </div>
      `;
    });
    html += '</div>';
  } else {
    html += '<p>No schedule data available.</p>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ============================================================
// Commissioner Page
// ============================================================
function renderCommissioner() {
  const loggedIn = localStorage.getItem('wmmc_commissioner_logged_in');
  if (loggedIn) {
    COMMISSIONER_EMAIL = loggedIn;
    showCommissionerPanel();
  }

  document.getElementById('commissioner-login-btn').onclick = () => {
    const email = document.getElementById('commissioner-email').value.trim().toLowerCase();
    if (!email) return;

    const managers = getManagers();
    const mgr = managers.find(m => m.email.toLowerCase() === email && m.commissioner);

    if (mgr) {
      COMMISSIONER_EMAIL = email;
      localStorage.setItem('wmmc_commissioner_logged_in', email);
      document.getElementById('login-error').style.display = 'none';
      showCommissionerPanel();
    } else {
      const err = document.getElementById('login-error');
      err.textContent = 'Access denied. Only commissioners can log in.';
      err.style.display = 'block';
    }
  };

  document.getElementById('commissioner-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('commissioner-login-btn').click();
  });

  document.getElementById('commissioner-logout-btn').onclick = () => {
    COMMISSIONER_EMAIL = null;
    localStorage.removeItem('wmmc_commissioner_logged_in');
    document.getElementById('commissioner-login').style.display = 'block';
    document.getElementById('commissioner-panel').style.display = 'none';
  };
}

function showCommissionerPanel() {
  document.getElementById('commissioner-login').style.display = 'none';
  document.getElementById('commissioner-panel').style.display = 'block';

  const managers = getManagers();
  const mgr = managers.find(m => m.email.toLowerCase() === COMMISSIONER_EMAIL);
  document.getElementById('commissioner-name').textContent = mgr ? mgr.name : COMMISSIONER_EMAIL;
  document.getElementById('season-setup-title').textContent = `${SELECTED_SEASON} Season Setup`;

  renderManagersTable();
  renderPlayerPoolDisplay();
  renderWeeklyUploadSections();
  setupPlayerPoolUploads();
}

// ---- Manager Management ----
let editingManagerIndex = -1;

function renderManagersTable() {
  const managers = getManagers();
  const table = document.getElementById('managers-table');

  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th><th>Email</th><th>Commissioner</th><th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${managers.map((m, i) => `
        <tr>
          <td><strong>${m.name}</strong></td>
          <td>${m.email}</td>
          <td>${m.commissioner ? '<span class="badge badge-winner">Yes</span>' : 'No'}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="editManager(${i})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteManager(${i})">Delete</button>
          </td>
        </tr>
      `).join('')}
    </tbody>
  `;

  // Save manager button
  document.getElementById('save-manager-btn').onclick = () => {
    const name = document.getElementById('mgr-name').value.trim();
    const email = document.getElementById('mgr-email').value.trim().toLowerCase();
    const isCommissioner = document.getElementById('mgr-commissioner').checked;

    if (!name || !email) {
      alert('Name and email are required.');
      return;
    }

    const managers = getManagers();

    if (editingManagerIndex >= 0) {
      managers[editingManagerIndex] = { name, email, commissioner: isCommissioner };
      editingManagerIndex = -1;
      document.getElementById('cancel-edit-btn').style.display = 'none';
    } else {
      if (managers.find(m => m.email.toLowerCase() === email)) {
        alert('A manager with this email already exists.');
        return;
      }
      managers.push({ name, email, commissioner: isCommissioner });
    }

    saveManagers(managers);
    document.getElementById('mgr-name').value = '';
    document.getElementById('mgr-email').value = '';
    document.getElementById('mgr-commissioner').checked = false;
    renderManagersTable();
  };

  document.getElementById('cancel-edit-btn').onclick = () => {
    editingManagerIndex = -1;
    document.getElementById('mgr-name').value = '';
    document.getElementById('mgr-email').value = '';
    document.getElementById('mgr-commissioner').checked = false;
    document.getElementById('cancel-edit-btn').style.display = 'none';
  };
}

window.editManager = function(index) {
  const managers = getManagers();
  const m = managers[index];
  document.getElementById('mgr-name').value = m.name;
  document.getElementById('mgr-email').value = m.email;
  document.getElementById('mgr-commissioner').checked = m.commissioner;
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
function renderWeeklyUploadSections() {
  const container = document.getElementById('weekly-upload-sections');
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];

  if (!sd || sd.status === 'completed') {
    container.innerHTML = '<p>This is a completed season. No uploads needed.</p>';
    return;
  }

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];

  // Determine which weeks have data
  const uploadedBatting = new Set();
  const uploadedPitching = new Set();
  batting.forEach(b => uploadedBatting.add(`${b.round}|${b.week}`));
  pitching.forEach(p => uploadedPitching.add(`${p.round}|${p.week}`));

  let html = '';
  SEASON_SCHEDULE.forEach((s, i) => {
    const weekKey = `${s.round}|${s.week}`;
    const hasBatting = uploadedBatting.has(weekKey);
    const hasPitching = uploadedPitching.has(weekKey);
    const isComplete = hasBatting && hasPitching;

    html += `
      <div class="weekly-upload-block ${isComplete ? 'upload-complete' : ''}">
        <div class="weekly-upload-header">
          <h3>${s.label}</h3>
          <span class="badge ${isComplete ? 'badge-winner' : 'badge-wildcard'}">${isComplete ? 'Complete' : 'Pending'}</span>
        </div>
        <div class="two-col" style="margin-top:0.5rem;">
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
        <div id="upload-status-${i}" class="upload-status"></div>
      </div>
    `;
  });

  container.innerHTML = html;
}

window.uploadWeeklyBatting = function(weekIndex) {
  const scheduleWeek = SEASON_SCHEDULE[weekIndex];
  const fileInput = document.getElementById(`upload-bat-${weekIndex}`);
  if (!fileInput.files[0]) { alert('Select a file first.'); return; }

  parseCSVFileWithStats(fileInput.files[0], (rows) => {
    const seasons = getSeasons();
    const sd = seasons[SELECTED_SEASON];
    if (!sd.weekly_batting) sd.weekly_batting = [];

    // Remove existing data for this week
    sd.weekly_batting = sd.weekly_batting.filter(b =>
      !(b.round === scheduleWeek.round && b.week === scheduleWeek.week)
    );

    // Process each row - expects columns like: Manager, Batter/Player/Name, AB, 1B, 2B, 3B, HR, R, RBI, SB, BB
    const managers = getManagers();
    const managerNames = managers.map(m => m.name.toLowerCase());

    // Compute cumulative totals for each batter
    const batterTotals = {};
    sd.weekly_batting.forEach(b => {
      if (!batterTotals[b.batter]) batterTotals[b.batter] = 0;
      batterTotals[b.batter] += (b.weekly_score || 0);
    });

    rows.forEach(row => {
      const manager = findColumn(row, ['manager', 'owner', 'team']);
      const batter = findColumn(row, ['batter', 'player', 'name']);
      if (!manager || !batter) return;

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

      const weeklyScore = calculateBattingScore(stats);
      const previousTotal = batterTotals[batter] || 0;

      sd.weekly_batting.push({
        round: scheduleWeek.round,
        week: scheduleWeek.week,
        manager: manager,
        batter: batter,
        status: row['status'] || row['Status'] || null,
        ...stats,
        weekly_score: weeklyScore,
        total_score: Math.round((previousTotal + weeklyScore) * 100) / 100
      });
    });

    saveSeason(SELECTED_SEASON, sd);
    document.getElementById(`upload-status-${weekIndex}`).innerHTML =
      `<p class="success-text">Uploaded ${rows.length} batter records. Scores calculated.</p>`;
    renderWeeklyUploadSections();
    fileInput.value = '';

    // Refresh displays
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

    // Remove existing data for this week
    sd.weekly_pitching = sd.weekly_pitching.filter(p =>
      !(p.round === scheduleWeek.round && p.week === scheduleWeek.week)
    );

    rows.forEach(row => {
      const manager = findColumn(row, ['manager', 'owner', 'team']);
      const pitcher = findColumn(row, ['pitcher', 'player', 'name']);
      if (!manager || !pitcher) return;

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

      const weeklyScore = calculatePitchingScore(stats);

      sd.weekly_pitching.push({
        round: scheduleWeek.round,
        week: scheduleWeek.week,
        manager: manager,
        pitcher: pitcher,
        status: row['status'] || row['Status'] || null,
        ...stats,
        weekly_score: weeklyScore
      });
    });

    saveSeason(SELECTED_SEASON, sd);
    document.getElementById(`upload-status-${weekIndex}`).innerHTML =
      `<p class="success-text">Uploaded ${rows.length} pitcher records. Scores calculated.</p>`;
    renderWeeklyUploadSections();
    fileInput.value = '';

    // Refresh displays
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
      // Assume the first column is the name
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

function resetSelect(id, options) {
  const select = document.getElementById(id);
  const current = select.value;
  // Keep the "all" option and re-populate
  select.innerHTML = `<option value="all">${select.querySelector('option').textContent}</option>`;
  options.forEach(opt => {
    if (opt) {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = opt;
      select.appendChild(el);
    }
  });
  // Restore selection if still valid
  if ([...select.options].some(o => o.value === current)) {
    select.value = current;
  }
}

// Load and start
loadData();
