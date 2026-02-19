// ============================================================
// WMMC - The Whit Merrifield Memorial Cup
// Multi-season app with Commissioner management
// ============================================================

let DATA = null;           // Data for the currently viewed season
let CURRENT_YEAR = new Date().getFullYear();
let SELECTED_SEASON = null;
let COMMISSIONER_EMAIL = null;
let ROSTER_EMAIL = null;

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

  if (seasonData.status === 'completed' && seasonData.data) {
    DATA = seasonData.data;
    showHistoricalSeason();
  } else {
    DATA = null;
    showActiveSeason(seasonData);
  }

  setupNav();
  setupMyRoster();
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
// Historical Season (completed)
// ============================================================
function showHistoricalSeason() {
  renderScoreboard();
  renderWeekly();
  renderPlayers();
  renderBracket();
  renderSwaps();
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

  let html = '';

  // Scoring period tabs
  html += `<div class="card scoreboard-card">
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
  </div>`;

  // Awards
  html += renderAwardsContent();

  container.innerHTML = html;
  setupScoreboardTabs();
}

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

    const table = document.getElementById('weekly-table');
    table.classList.add('compact-table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Rnd</th><th>Wk</th><th>Manager</th><th>Pool</th>
          <th>Bat</th><th>Bat Rk</th>
          <th>Pit</th><th>Pit Rk</th>
          <th>Total</th><th>Tot Rk</th>
          <th>Cum Bat</th><th>Cum Pit</th><th>Cum Tot</th>
          <th>Pool Rk</th>
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
  // Repair any data where manager was incorrectly set to MLB team abbreviation
  if (repairManagerAssignments(seasonData)) {
    saveSeason(SELECTED_SEASON, seasonData);
  }

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

  // Clear historical-only sections
  document.getElementById('bracket-container').innerHTML = '<p>Bracket will be available during playoff rounds.</p>';
  document.getElementById('swaps-table').innerHTML = '';
}

function renderActiveScoreboardTabs(seasonData, managerScores, managers) {
  const p2m = buildPlayerToManagerMap(seasonData);
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
      const mgr = p2m[b.batter];
      if (!mgr) return;
      if (!mgrMap[mgr]) mgrMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
      mgrMap[mgr].batting += (b.weekly_score || 0);
    });
    pitching.filter(p => roundFilter.includes(p.round)).forEach(p => {
      const mgr = p2m[p.pitcher];
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
  let html = '';

  // Pool Play Overall (combined PP1 + PP2, single list sorted by total)
  html += `<div class="card scoreboard-section">
    <h2>Pool Play Overall</h2>
    ${renderOverallTable(overallScores)}
  </div>`;

  // Pool Play 1
  html += `<div class="card scoreboard-section">
    <h2>Pool Play 1</h2>
    ${renderPoolSection(pp1Scores, 'Pool Play 1', 'pp1')}
  </div>`;

  // Pool Play 2
  html += `<div class="card scoreboard-section">
    <h2>Pool Play 2</h2>
    ${renderPoolSection(pp2Scores, 'Pool Play 2', 'pp2')}
  </div>`;

  // Playoff Advancement summary
  if (allPPWinners.size > 0 || wildcardSet.size > 0) {
    html += `<div class="card scoreboard-section">
      <h2>Playoff Advancement</h2>
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

  // Playoff period tabs (QF / SF / Finals) — only if data exists
  const rounds = new Set([...batting.map(b => b.round), ...pitching.map(p => p.round)]);
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

  // Resolve manager names from rosters ONLY — never fall back to stored field (which may be an MLB team)
  const p2m = buildPlayerToManagerMap(seasonData);
  const fixedBatting = batting.map(b => ({ ...b, manager: p2m[b.batter] || '(Unassigned)' }));
  const fixedPitching = pitching.map(p => ({ ...p, manager: p2m[p.pitcher] || '(Unassigned)' }));

  const origData = DATA;
  DATA = { batting_weekly: fixedBatting, pitching_weekly: fixedPitching };
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

// Repair any weekly data where 'manager' is an MLB team abbreviation instead of a WMMC manager name
function repairManagerAssignments(seasonData) {
  if (!seasonData || seasonData.status === 'completed') return false;

  const managers = getManagers();
  const managerNames = new Set(managers.map(m => m.name));
  const rosters = seasonData.rosters || {};
  let repaired = false;

  // Build player-to-manager lookup from rosters
  const playerToManager = {};
  for (const [managerName, roster] of Object.entries(rosters)) {
    (roster.batters || []).forEach(b => { playerToManager[b] = managerName; });
    (roster.pitchers || []).forEach(p => { playerToManager[p] = managerName; });
  }

  // Repair batting entries
  (seasonData.weekly_batting || []).forEach(entry => {
    if (!managerNames.has(entry.manager)) {
      // Manager field doesn't match any registered manager - try roster lookup
      const correctManager = playerToManager[entry.batter];
      if (correctManager) {
        entry.manager = correctManager;
        repaired = true;
      }
    }
  });

  // Repair pitching entries
  (seasonData.weekly_pitching || []).forEach(entry => {
    if (!managerNames.has(entry.manager)) {
      const correctManager = playerToManager[entry.pitcher];
      if (correctManager) {
        entry.manager = correctManager;
        repaired = true;
      }
    }
  });

  return repaired;
}

// Build a player-to-manager lookup from rosters (used at display time)
function buildPlayerToManagerMap(seasonData) {
  const map = {};
  const rosters = (seasonData && seasonData.rosters) || {};
  for (const [managerName, roster] of Object.entries(rosters)) {
    (roster.batters || []).forEach(b => { map[b] = managerName; });
    (roster.pitchers || []).forEach(p => { map[p] = managerName; });
  }
  return map;
}


function computeManagerScores(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  const p2m = buildPlayerToManagerMap(seasonData);

  const managerMap = {};
  batting.forEach(b => {
    const mgr = p2m[b.batter]; // roster-only lookup — no fallback to stored field
    if (!mgr) return;           // skip players not assigned to any manager roster
    if (!managerMap[mgr]) managerMap[mgr] = { manager: mgr, batting: 0, pitching: 0, total: 0 };
    managerMap[mgr].batting += (b.weekly_score || 0);
  });
  pitching.forEach(p => {
    const mgr = p2m[p.pitcher]; // roster-only lookup
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
  const p2m = buildPlayerToManagerMap(seasonData);

  // Build manager-to-pool lookup
  const managerPool = {};
  managers.forEach(m => { if (m.pool) managerPool[m.name] = 'Pool ' + m.pool; });

  const key = (r, w, m) => `${r}|${w}|${m}`;
  const map = {};

  batting.forEach(b => {
    const mgr = p2m[b.batter]; // roster-only lookup — no fallback
    if (!mgr) return;           // skip unassigned players
    const k = key(b.round, b.week, mgr);
    if (!map[k]) map[k] = { round: b.round, week: b.week, manager: mgr, pool: managerPool[mgr] || '', weekly_batting: 0, weekly_pitching: 0, weekly_total: 0 };
    map[k].weekly_batting += (b.weekly_score || 0);
  });

  pitching.forEach(p => {
    const mgr = p2m[p.pitcher]; // roster-only lookup
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
function renderSchedule() {
  const container = document.getElementById('schedule-content');
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];

  if (!seasonData) { container.innerHTML = ''; return; }

  const isActive = seasonData.status === 'active';

  let html = `<div class="card"><h2>${SELECTED_SEASON} Season Schedule</h2>`;

  if (!isActive && seasonData.data && seasonData.data.team_weekly) {
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
// My Roster Page
// ============================================================
function setupMyRoster() {
  const loginBtn = document.getElementById('roster-login-btn');
  const emailInput = document.getElementById('roster-email');

  // Auto-login from localStorage
  const savedEmail = localStorage.getItem('wmmc_roster_email');
  if (savedEmail) {
    emailInput.value = savedEmail;
    rosterLogin(savedEmail);
  }

  loginBtn.onclick = () => {
    const email = emailInput.value.trim().toLowerCase();
    if (!email) return;
    rosterLogin(email);
  };

  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });
}

function rosterLogin(email) {
  email = email.trim().toLowerCase();
  const managers = getManagers();
  let managerName = null;

  const mgr = managers.find(m => m.email.toLowerCase() === email);
  if (mgr) {
    managerName = mgr.name;
  }
  if (!managerName && DATA && DATA.email_map) {
    managerName = DATA.email_map[email];
  }

  if (managerName) {
    ROSTER_EMAIL = email;
    localStorage.setItem('wmmc_roster_email', email);
    document.getElementById('roster-login-error').style.display = 'none';
    document.getElementById('roster-login-section').style.display = 'none';
    document.getElementById('roster-panel').style.display = 'block';

    const isCommissioner = !!managers.find(m => m.email.toLowerCase() === email && m.commissioner);

    const manualSection = document.getElementById('manual-update-section');
    if (isCommissioner) {
      manualSection.style.display = 'block';
      setupManualUpdate();
    } else {
      manualSection.style.display = 'none';
    }

    renderRosterData(managerName, isCommissioner);
  } else {
    const err = document.getElementById('roster-login-error');
    err.textContent = 'Email not found. Please use the email registered with your team.';
    err.style.display = 'block';
  }
}

function rosterLogout() {
  ROSTER_EMAIL = null;
  localStorage.removeItem('wmmc_roster_email');
  document.getElementById('roster-login-section').style.display = 'block';
  document.getElementById('roster-panel').style.display = 'none';
  document.getElementById('manual-update-section').style.display = 'none';
  document.getElementById('roster-email').value = '';
}

function renderRosterData(managerName, isCommissioner) {
  const container = document.getElementById('roster-content');
  const seasons = getSeasons();
  const seasonData = seasons[SELECTED_SEASON];
  const isActive = seasonData && seasonData.status === 'active';
  const p2m = isActive ? buildPlayerToManagerMap(seasonData) : {};

  // Gather roster player lists
  let batters = [];
  let pitchers = [];

  if (isActive && seasonData.rosters && seasonData.rosters[managerName]) {
    batters = seasonData.rosters[managerName].batters || [];
    pitchers = seasonData.rosters[managerName].pitchers || [];
  } else if (DATA && (DATA.batting_weekly || DATA.pitching_weekly)) {
    batters = [...new Set((DATA.batting_weekly || []).filter(b => b.manager === managerName).map(b => b.batter))];
    pitchers = [...new Set((DATA.pitching_weekly || []).filter(p => p.manager === managerName).map(p => p.pitcher))];
  }

  // Compute per-period scores for this manager
  const periodScores = computeRosterPeriodScores(managerName, seasonData, p2m);

  // Compute per-player stat totals and rankings
  const batterStatTotals = computePlayerStatTotals(managerName, 'batting', seasonData, p2m);
  const pitcherStatTotals = computePlayerStatTotals(managerName, 'pitching', seasonData, p2m);
  const batterRankings = computePlayerRankings('batting', seasonData, p2m);
  const pitcherRankings = computePlayerRankings('pitching', seasonData, p2m);

  // Available players for commissioner add (active season only)
  let availBatters = [];
  let availPitchers = [];
  if (isCommissioner && isActive) {
    const rosteredBatters = new Set();
    const rosteredPitchers = new Set();
    Object.values(seasonData.rosters || {}).forEach(r => {
      (r.batters || []).forEach(b => rosteredBatters.add(b));
      (r.pitchers || []).forEach(p => rosteredPitchers.add(p));
    });
    availBatters = (seasonData.batters_pool || []).filter(b => !rosteredBatters.has(b));
    availPitchers = (seasonData.pitchers_pool || []).filter(p => !rosteredPitchers.has(p));
  }

  let html = '';

  // ---- Header ----
  html += `<div class="card">
    <div class="roster-header">
      <h2>${managerName}</h2>
      <button class="btn btn-secondary btn-sm" onclick="rosterLogout()">Logout</button>
    </div>
  </div>`;

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
  // Season total card
  const totalBat = Object.values(periodScores).reduce((s, p) => s + p.batting, 0);
  const totalPit = Object.values(periodScores).reduce((s, p) => s + p.pitching, 0);
  const totalAll = Math.round((totalBat + totalPit) * 100) / 100;
  html += `<div class="roster-score-card roster-score-total">
    <div class="roster-score-label">Season Total</div>
    <div class="roster-score-value">${fmt(totalAll)}</div>
    <div class="roster-score-detail">Bat: ${fmt(Math.round(totalBat * 100) / 100)} | Pit: ${fmt(Math.round(totalPit * 100) / 100)}</div>
  </div>`;
  html += '</div>';

  // ---- Roster Counts ----
  html += `<div class="roster-counts">
    <div class="roster-count-card">
      <span class="roster-count-num">${batters.length}</span>
      <span class="roster-count-label">Batters</span>
    </div>
    <div class="roster-count-card">
      <span class="roster-count-num">${pitchers.length}</span>
      <span class="roster-count-label">Pitchers</span>
    </div>
  </div>`;

  // ---- Batters Table ----
  html += '<div class="card">';
  html += '<h2>Batters</h2>';
  if (batters.length > 0) {
    html += '<div class="table-wrapper"><table class="data-table compact-table"><thead><tr>';
    html += '<th>Player</th><th>AB</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>R</th><th>RBI</th><th>SB</th><th>BB</th><th>Pts</th><th>Rank</th>';
    if (isCommissioner && isActive) html += '<th></th>';
    html += '</tr></thead><tbody>';
    batters.forEach(b => {
      const s = batterStatTotals[b] || {};
      const pts = s.points || 0;
      const rk = batterRankings[b];
      const rkStr = rk ? `#${rk.overallRank}/${rk.totalPlayers}` : '-';
      const safeName = b.replace(/'/g, "\\'");
      html += `<tr><td>${b}</td>`;
      html += `<td class="num">${s.abs || 0}</td>`;
      html += `<td class="num">${s['1b'] || 0}</td>`;
      html += `<td class="num">${s['2b'] || 0}</td>`;
      html += `<td class="num">${s['3b'] || 0}</td>`;
      html += `<td class="num">${s.hr || 0}</td>`;
      html += `<td class="num">${s.r || 0}</td>`;
      html += `<td class="num">${s.rbi || 0}</td>`;
      html += `<td class="num">${s.sb || 0}</td>`;
      html += `<td class="num">${s.bb || 0}</td>`;
      html += `<td class="num"><strong>${fmt(pts)}</strong></td>`;
      html += `<td class="rank">${rkStr}</td>`;
      if (isCommissioner && isActive) {
        html += `<td class="num"><button class="btn btn-sm btn-danger" onclick="showDropForm('${managerName.replace(/'/g, "\\'")}', 'batters', '${safeName}', this)">Remove</button></td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="text-muted">No batters assigned.</p>';
  }
  // Commissioner: add batter
  if (isCommissioner && isActive && availBatters.length > 0) {
    html += `<div class="roster-add-row">
      <select id="add-batter-select" class="form-select"><option value="">Add batter...</option>
        ${availBatters.map(b => `<option value="${b}">${b}</option>`).join('')}
      </select>
      <input type="date" id="add-batter-date" class="form-select" value="${new Date().toISOString().split('T')[0]}" style="max-width:160px;">
      <button class="btn btn-sm btn-primary" onclick="addToRoster('${managerName.replace(/'/g, "\\'")}', 'batters', 'add-batter-select', 'add-batter-date')">Add</button>
    </div>`;
  }
  html += '</div>';

  // ---- Pitchers Table ----
  html += '<div class="card">';
  html += '<h2>Pitchers</h2>';
  if (pitchers.length > 0) {
    html += '<div class="table-wrapper"><table class="data-table compact-table"><thead><tr>';
    html += '<th>Player</th><th>GS</th><th>W</th><th>QS</th><th>CG</th><th>CGSO</th><th>NH</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>Pts</th><th>Rank</th>';
    if (isCommissioner && isActive) html += '<th></th>';
    html += '</tr></thead><tbody>';
    pitchers.forEach(p => {
      const s = pitcherStatTotals[p] || {};
      const pts = s.points || 0;
      const rk = pitcherRankings[p];
      const rkStr = rk ? `#${rk.overallRank}/${rk.totalPlayers}` : '-';
      const safeName = p.replace(/'/g, "\\'");
      html += `<tr><td>${p}</td>`;
      html += `<td class="num">${s.gs || 0}</td>`;
      html += `<td class="num">${s.w || 0}</td>`;
      html += `<td class="num">${fmtDec(s.qs || 0)}</td>`;
      html += `<td class="num">${s.cg || 0}</td>`;
      html += `<td class="num">${s.cgso || 0}</td>`;
      html += `<td class="num">${s.nh || 0}</td>`;
      html += `<td class="num">${fmtDec(s.ip || 0)}</td>`;
      html += `<td class="num">${s.h || 0}</td>`;
      html += `<td class="num">${s.er || 0}</td>`;
      html += `<td class="num">${s.bb || 0}</td>`;
      html += `<td class="num">${s.k || 0}</td>`;
      html += `<td class="num"><strong>${fmt(pts)}</strong></td>`;
      html += `<td class="rank">${rkStr}</td>`;
      if (isCommissioner && isActive) {
        html += `<td class="num"><button class="btn btn-sm btn-danger" onclick="showDropForm('${managerName.replace(/'/g, "\\'")}', 'pitchers', '${safeName}', this)">Remove</button></td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="text-muted">No pitchers assigned.</p>';
  }
  // Commissioner: add pitcher
  if (isCommissioner && isActive && availPitchers.length > 0) {
    html += `<div class="roster-add-row">
      <select id="add-pitcher-select" class="form-select"><option value="">Add pitcher...</option>
        ${availPitchers.map(p => `<option value="${p}">${p}</option>`).join('')}
      </select>
      <input type="date" id="add-pitcher-date" class="form-select" value="${new Date().toISOString().split('T')[0]}" style="max-width:160px;">
      <button class="btn btn-sm btn-primary" onclick="addToRoster('${managerName.replace(/'/g, "\\'")}', 'pitchers', 'add-pitcher-select', 'add-pitcher-date')">Add</button>
    </div>`;
  }
  html += '</div>';

  // ---- Team Stats Breakdown ----
  html += buildTeamStatsBreakdown(managerName, seasonData, p2m);

  // ---- Player Swaps ----
  html += buildPlayerSwapsSection(managerName, isCommissioner, seasonData, p2m);

  container.innerHTML = html;
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
    if (p2m[b.batter] !== managerName) return;
    if (!result[b.round]) result[b.round] = { batting: 0, pitching: 0, total: 0 };
    result[b.round].batting += (b.weekly_score || 0);
  });
  pitching.forEach(p => {
    if (p2m[p.pitcher] !== managerName) return;
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
      if (p2m[e[nameKey]] !== managerName) return;
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
    filterFn = e => p2m[e[nameKey]] === managerName;
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
        .filter(e => e.round === period.key && p2m[e.batter] === managerName)
        .forEach(e => {
          if (!weekTotals[e.week]) weekTotals[e.week] = { batting: 0, pitching: 0 };
          weekTotals[e.week].batting += (e.weekly_score || 0);
          batterPeriodTotals[e.batter] = (batterPeriodTotals[e.batter] || 0) + (e.weekly_score || 0);
        });
      (seasonData.weekly_pitching || [])
        .filter(e => e.round === period.key && p2m[e.pitcher] === managerName)
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
    const roster = (seasonData.rosters && seasonData.rosters[managerName]) || { batters: [], pitchers: [] };

    // Build available (non-rostered) players from pool
    const rosteredBatters = new Set();
    const rosteredPitchers = new Set();
    Object.values(seasonData.rosters || {}).forEach(r => {
      (r.batters || []).forEach(b => rosteredBatters.add(b));
      (r.pitchers || []).forEach(p => rosteredPitchers.add(p));
    });
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

  // All Swaps list
  html += `<div class="swap-list-section">
    <h3>All Swaps</h3>`;
  if (mySwaps.length > 0) {
    const sorted = [...mySwaps].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    html += '<div class="swap-list">';
    sorted.forEach(s => {
      const status = s.status || 'approved'; // historical swaps have no status field
      const badgeClass = status === 'approved' ? 'swap-badge-approved'
        : status === 'pending' ? 'swap-badge-pending'
        : 'swap-badge-denied';
      const badgeLabel = status.charAt(0).toUpperCase() + status.slice(1);
      const date = s.swap_date || (s.timestamp ? s.timestamp.split(' ')[0] : '');
      html += `<div class="swap-list-item">
        <div class="swap-list-main">
          <span class="swap-list-players">${s.player_out || '?'} &rarr; ${s.player_in || '?'}</span>
          <span class="swap-badge ${badgeClass}">${badgeLabel}</span>
        </div>
        <div class="swap-list-meta">
          <span class="swap-list-reason">${s.reason || ''}</span>
          <span class="swap-list-date">${date}</span>
        </div>
      </div>`;
    });
    html += '</div>';
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

  // Execute the roster swap
  if (sd.rosters && sd.rosters[swap.manager]) {
    const roster = sd.rosters[swap.manager];
    // Determine if player_out is a batter or pitcher
    const isBatter = roster.batters.includes(swap.player_out);
    const isPitcher = roster.pitchers.includes(swap.player_out);

    if (isBatter) {
      roster.batters = roster.batters.filter(b => b !== swap.player_out);
      if (!roster.batters.includes(swap.player_in)) roster.batters.push(swap.player_in);
    } else if (isPitcher) {
      roster.pitchers = roster.pitchers.filter(p => p !== swap.player_out);
      if (!roster.pitchers.includes(swap.player_in)) roster.pitchers.push(swap.player_in);
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

  // Build available players for the swap target manager
  const roster = (sd.rosters && sd.rosters[swap.manager]) || { batters: [], pitchers: [] };
  const isBatter = roster.batters.includes(swap.player_out);
  const rosterPlayers = isBatter ? roster.batters : roster.pitchers;

  const rosteredAll = new Set();
  Object.values(sd.rosters || {}).forEach(r => {
    (r.batters || []).forEach(b => rosteredAll.add(b));
    (r.pitchers || []).forEach(p => rosteredAll.add(p));
  });
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
  weekSelect.innerHTML = SEASON_SCHEDULE.map((s, i) => `<option value="${i}">${s.label}</option>`).join('');

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

      // Auto-add player to roster if not already rostered
      if (!sd.rosters) sd.rosters = {};
      if (!sd.rosters[manager]) sd.rosters[manager] = { batters: [], pitchers: [] };
      if (!sd.rosters[manager].batters.includes(playerName)) {
        sd.rosters[manager].batters.push(playerName);
      }

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

      // Auto-add player to roster if not already rostered
      if (!sd.rosters) sd.rosters = {};
      if (!sd.rosters[manager]) sd.rosters[manager] = { batters: [], pitchers: [] };
      if (!sd.rosters[manager].pitchers.includes(playerName)) {
        sd.rosters[manager].pitchers.push(playerName);
      }

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
  setupSeasonSetupToggle();
}

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
}

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

window.addToRoster = function(manager, type, selectId, dateSelectId) {
  const select = document.getElementById(selectId);
  const player = select.value;
  if (!player) return;

  const dateInput = dateSelectId ? document.getElementById(dateSelectId) : null;
  const addDate = dateInput ? dateInput.value : new Date().toISOString().split('T')[0];
  if (!addDate) { alert('Please select an add date.'); return; }

  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.rosters) sd.rosters = {};
  if (!sd.rosters[manager]) sd.rosters[manager] = { batters: [], pitchers: [] };

  if (!sd.rosters[manager][type].includes(player)) {
    sd.rosters[manager][type].push(player);

    // Create swap log entry for the add
    if (!sd.swaps) sd.swaps = [];
    sd.swaps.push({
      id: Date.now().toString(),
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      email: ROSTER_EMAIL,
      manager: manager,
      player_out: null,
      player_in: player,
      reason: 'Commissioner Add',
      swap_date: addDate,
      status: 'approved',
    });

    saveSeason(SELECTED_SEASON, sd);
  }

  renderRosterData(manager, true);
};

window.showDropForm = function(manager, type, player, btnElement) {
  const td = btnElement.parentElement;
  const safeKey = player.replace(/[^a-zA-Z0-9]/g, '_');
  td.innerHTML = `
    <div style="display:flex;gap:0.25rem;align-items:center;flex-wrap:wrap;">
      <input type="date" id="drop-date-${safeKey}" value="${new Date().toISOString().split('T')[0]}" style="font-size:0.75rem;padding:0.2rem;max-width:130px;">
      <select id="drop-reason-${safeKey}" style="font-size:0.75rem;padding:0.2rem;">
        ${SWAP_REASONS.map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-danger" onclick="removeFromRoster('${manager.replace(/'/g, "\\'")}', '${type}', '${player.replace(/'/g, "\\'")}', '${safeKey}')">Drop</button>
      <button class="btn btn-sm btn-secondary" onclick="cancelDrop('${manager.replace(/'/g, "\\'")}')">Cancel</button>
    </div>`;
};

window.cancelDrop = function(manager) {
  renderRosterData(manager, true);
};

window.removeFromRoster = function(manager, type, player, safeKey) {
  const seasons = getSeasons();
  const sd = seasons[SELECTED_SEASON];
  if (!sd.rosters || !sd.rosters[manager]) return;

  let dropDate, dropReason;
  if (safeKey) {
    const dateEl = document.getElementById('drop-date-' + safeKey);
    const reasonEl = document.getElementById('drop-reason-' + safeKey);
    dropDate = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
    dropReason = reasonEl ? reasonEl.value : 'Drop Swap';
    if (!dropDate) { alert('Please select a drop date.'); return; }
  } else {
    dropDate = new Date().toISOString().split('T')[0];
    dropReason = 'Drop Swap';
  }

  sd.rosters[manager][type] = sd.rosters[manager][type].filter(p => p !== player);

  // Create swap log entry for the drop
  if (!sd.swaps) sd.swaps = [];
  sd.swaps.push({
    id: Date.now().toString(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    email: ROSTER_EMAIL,
    manager: manager,
    player_out: player,
    player_in: null,
    reason: dropReason,
    swap_date: dropDate,
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

// Helper: find which manager owns a player via roster assignments
function findManagerForPlayer(seasonData, playerName, type) {
  const rosters = seasonData.rosters || {};
  const rosterKey = type === 'batting' ? 'batters' : 'pitchers';
  for (const [managerName, roster] of Object.entries(rosters)) {
    if ((roster[rosterKey] || []).includes(playerName)) {
      return managerName;
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

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];

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

    sd.weekly_batting = sd.weekly_batting.filter(b =>
      !(b.round === scheduleWeek.round && b.week === scheduleWeek.week)
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

      // Resolve manager: first try roster lookup, then CSV column fallback
      let manager = findManagerForPlayer(sd, batter, 'batting');
      if (!manager) {
        manager = findColumn(row, ['manager', 'owner']);
      }
      if (!manager) { skipped++; return; }

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
      imported++;
    });

    saveSeason(SELECTED_SEASON, sd);
    let statusMsg = `Uploaded ${imported} batter records. Scores calculated.`;
    if (skipped > 0) statusMsg += ` ${skipped} rows skipped (player not found in any roster).`;
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

    sd.weekly_pitching = sd.weekly_pitching.filter(p =>
      !(p.round === scheduleWeek.round && p.week === scheduleWeek.week)
    );

    let imported = 0;
    let skipped = 0;
    rows.forEach(row => {
      const pitcher = findColumn(row, ['pitcher', 'player', 'name']);
      if (!pitcher) return;

      // Resolve manager: first try roster lookup, then CSV column fallback
      let manager = findManagerForPlayer(sd, pitcher, 'pitching');
      if (!manager) {
        manager = findColumn(row, ['manager', 'owner']);
      }
      if (!manager) { skipped++; return; }

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
      imported++;
    });

    saveSeason(SELECTED_SEASON, sd);
    let statusMsg = `Uploaded ${imported} pitcher records. Scores calculated.`;
    if (skipped > 0) statusMsg += ` ${skipped} rows skipped (player not found in any roster).`;
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

function resetSelect(id, options) {
  const select = document.getElementById(id);
  const current = select.value;
  select.innerHTML = `<option value="all">${select.querySelector('option').textContent}</option>`;
  options.forEach(opt => {
    if (opt) {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = opt;
      select.appendChild(el);
    }
  });
  if ([...select.options].some(o => o.value === current)) {
    select.value = current;
  }
}

// Load and start
loadData();
