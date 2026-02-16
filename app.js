let DATA = null;

async function loadData() {
  const resp = await fetch('data.json');
  DATA = await resp.json();
  init();
}

function init() {
  setupNav();
  renderDashboard();
  renderStandings();
  renderWeekly();
  renderPlayers();
  renderBracket();
  renderSwaps();
  renderRules();
}

// ---- Navigation ----
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

// ---- Dashboard ----
function renderDashboard() {
  const banner = document.getElementById('champion-banner');
  const finals = DATA.bracket.finals;
  banner.innerHTML = `
    <div class="trophy">&#127942;</div>
    <div class="champion-label">2025 WMMC Champion</div>
    <div class="champion-name">${finals.winner}</div>
    <div class="champion-details">
      Finals: ${finals.winner} ${finals.score2} - ${finals.score1} ${finals.manager1}<br>
      Batting: ${finals.batting2} | Pitching: ${finals.pitching2}
    </div>
  `;

  const stats = DATA.scoreboard.stats;
  const grid = document.getElementById('stats-grid');
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

  // Final standings table
  const table = document.getElementById('final-standings-table');
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

// ---- Standings ----
function renderStandings() {
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
  const wildcards = DATA.scoreboard.wildcards;
  const ppWinners = ['Marcus Gillespie', 'Daniel Kortan', 'Joey Auclair', 'Joey Auclair', 'Austin Johnson', 'Austin Johnson'];
  const qualifiedAsWinner = new Set();
  // Determine who qualified as PP winner vs wildcard
  // Pool winners: top of each pool in PP1 and PP2
  const pool1Winners = ['Marcus Gillespie', 'Daniel Kortan']; // PP1 rank 1, PP2 rank 1
  const pool2Winners = ['Joey Auclair', 'Joey Auclair']; // PP1 rank 1, PP2 rank 1
  const pool3Winners = ['Austin Johnson', 'Austin Johnson']; // PP1 rank 1, PP2 rank 1
  qualifiedAsWinner.add('Marcus Gillespie');
  qualifiedAsWinner.add('Daniel Kortan');
  qualifiedAsWinner.add('Joey Auclair');
  qualifiedAsWinner.add('Austin Johnson');

  // Top 8 qualify
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
  const rounds = [...new Set(DATA.team_weekly.map(t => t.round))];
  const weeks = [...new Set(DATA.team_weekly.map(t => t.week))];
  const managers = [...new Set(DATA.team_weekly.map(t => t.manager))].sort();

  populateSelect('weekly-round-filter', rounds);
  populateSelect('weekly-week-filter', weeks);
  populateSelect('weekly-manager-filter', managers);

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

  document.getElementById('weekly-round-filter').addEventListener('change', update);
  document.getElementById('weekly-week-filter').addEventListener('change', update);
  document.getElementById('weekly-manager-filter').addEventListener('change', update);
  update();
}

// ---- Player Stats ----
function renderPlayers() {
  let currentType = 'batting';

  const rounds = [...new Set(DATA.batting_weekly.map(b => b.round).concat(DATA.pitching_weekly.map(p => p.round)))].filter(Boolean);
  const weeks = [...new Set(DATA.batting_weekly.map(b => b.week).concat(DATA.pitching_weekly.map(p => p.week)))].filter(Boolean);
  const managers = [...new Set(DATA.batting_weekly.map(b => b.manager).concat(DATA.pitching_weekly.map(p => p.manager)))].filter(Boolean).sort();

  populateSelect('player-round-filter', rounds);
  populateSelect('player-week-filter', weeks);
  populateSelect('player-manager-filter', managers);

  const typeBtns = document.querySelectorAll('.type-btn');
  typeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      typeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentType = btn.dataset.type;
      updatePlayers();
    });
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

  document.getElementById('player-round-filter').addEventListener('change', updatePlayers);
  document.getElementById('player-week-filter').addEventListener('change', updatePlayers);
  document.getElementById('player-manager-filter').addEventListener('change', updatePlayers);
  updatePlayers();
}

// ---- Bracket ----
function renderBracket() {
  const b = DATA.bracket;
  const container = document.getElementById('bracket-container');

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
        ${b.qf_matchups.map(m => matchupHTML(m, true)).join('')}
      </div>
      <div class="bracket-round" style="margin-top: 3rem;">
        <h3>Semifinals</h3>
        ${b.sf_matchups.map(m => matchupHTML(m, true)).join('')}
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
  const managers = [...new Set(DATA.swaps.map(s => {
    return DATA.email_map[s.email] || s.email;
  }))].sort();
  populateSelect('swap-manager-filter', managers);

  const update = () => {
    const typeF = document.getElementById('swap-type-filter').value;
    const managerF = document.getElementById('swap-manager-filter').value;

    let filtered = DATA.swaps.map(s => ({
      ...s,
      manager: DATA.email_map[s.email] || s.email,
    }));

    if (typeF !== 'all') filtered = filtered.filter(s => s.reason === typeF);
    if (managerF !== 'all') filtered = filtered.filter(s => s.manager === managerF);

    // Sort by timestamp descending
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

  document.getElementById('swap-type-filter').addEventListener('change', update);
  document.getElementById('swap-manager-filter').addEventListener('change', update);
  update();
}

// ---- Rules ----
function renderRules() {
  const container = document.getElementById('rules-content');
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

  // Scoring tables
  const batTable = document.getElementById('batting-scoring-table');
  const pitchTable = document.getElementById('pitching-scoring-table');

  batTable.innerHTML = `
    <thead><tr><th>Category</th><th>Points</th></tr></thead>
    <tbody>
      ${Object.entries(DATA.scoring.batting).map(([k, v]) =>
        `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`
      ).join('')}
    </tbody>
  `;

  pitchTable.innerHTML = `
    <thead><tr><th>Category</th><th>Points</th></tr></thead>
    <tbody>
      ${Object.entries(DATA.scoring.pitching).map(([k, v]) =>
        `<tr><td>${k}</td><td class="${v >= 0 ? 'positive' : 'negative'}">${v}</td></tr>`
      ).join('')}
    </tbody>
  `;
}

// ---- Helpers ----
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
  for (const [pool, members] of Object.entries(DATA.scoreboard.pools)) {
    if (members.includes(manager)) return pool;
  }
  return '';
}

function populateSelect(id, options) {
  const select = document.getElementById(id);
  const currentOptions = [...select.querySelectorAll('option')].map(o => o.value);
  options.forEach(opt => {
    if (opt && !currentOptions.includes(opt)) {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = opt;
      select.appendChild(el);
    }
  });
}

// Load and start
loadData();
