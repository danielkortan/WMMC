// Mobile experience: bottom nav, more sheet, weekly score cards

const MOBILE_BREAKPOINT = 768;

function isMobile() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

// ── Bottom nav + more sheet ─────────────────────────────────────

function buildMobileNav() {
  const primaryTabs = [
    { icon: '⚾', label: 'Scoreboard', tab: 'dashboard' },
    { icon: '⚡', label: 'Live', tab: 'live' },
    { icon: '📋', label: 'Roster', tab: 'my-roster' },
    { icon: '📊', label: 'Scores', tab: 'weekly' },
  ];

  const moreTabs = [
    { icon: '📈', label: 'Trends', tab: 'trends' },
    { icon: 'ℹ️', label: 'League Info', tab: 'league-info' },
    { icon: '🏆', label: 'Hall of Fame', tab: 'hall-of-fame' },
  ];

  const MORE_TAB_IDS = new Set([...moreTabs.map((t) => t.tab), 'commissioner']);

  // Bottom nav bar
  const nav = document.createElement('nav');
  nav.id = 'mobile-bottom-nav';
  nav.className = 'mobile-bottom-nav';

  primaryTabs.forEach(({ icon, label, tab }) => {
    const btn = document.createElement('button');
    btn.className = 'mobile-nav-btn';
    btn.dataset.tab = tab;
    btn.innerHTML = `<span class="mnb-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => triggerTab(tab));
    nav.appendChild(btn);
  });

  const moreBtn = document.createElement('button');
  moreBtn.className = 'mobile-nav-btn';
  moreBtn.id = 'mobile-more-btn';
  moreBtn.innerHTML = `<span class="mnb-icon">☰</span><span>More</span>`;
  moreBtn.addEventListener('click', toggleMoreSheet);
  nav.appendChild(moreBtn);

  document.body.appendChild(nav);

  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'mobile-more-overlay';
  overlay.id = 'mobile-more-overlay';
  overlay.addEventListener('click', closeMoreSheet);
  document.body.appendChild(overlay);

  // More sheet
  const sheet = document.createElement('div');
  sheet.className = 'mobile-more-sheet';
  sheet.id = 'mobile-more-sheet';
  sheet.innerHTML = `<div class="mobile-more-sheet-handle"></div>`;

  moreTabs.forEach(({ icon, label, tab }) => {
    const btn = document.createElement('button');
    btn.className = 'mobile-more-item';
    btn.dataset.tab = tab;
    btn.innerHTML = `<span class="mmi-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => {
      triggerTab(tab);
      closeMoreSheet();
    });
    sheet.appendChild(btn);
  });

  // Commissioner (shown dynamically once logged in as commissioner)
  const commItem = document.createElement('button');
  commItem.className = 'mobile-more-item';
  commItem.id = 'mobile-more-comm';
  commItem.dataset.tab = 'commissioner';
  commItem.innerHTML = `<span class="mmi-icon">⚙️</span><span>Commissioner</span>`;
  commItem.style.display = 'none';
  commItem.addEventListener('click', () => {
    triggerTab('commissioner');
    closeMoreSheet();
  });
  sheet.appendChild(commItem);

  document.body.appendChild(sheet);

  // Sync active state whenever a desktop nav button is clicked
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isMobile()) syncActiveState(btn.dataset.tab, MORE_TAB_IDS);
    });
  });

  // Set initial active state
  const saved = localStorage.getItem('wmmc_active_tab') || 'dashboard';
  syncActiveState(saved, MORE_TAB_IDS);

  // Watch for commissioner login
  watchCommissioner();
}

function triggerTab(tabId) {
  const btn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

function syncActiveState(tabId, moreTabs) {
  document.querySelectorAll('#mobile-bottom-nav .mobile-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  const moreBtn = document.getElementById('mobile-more-btn');
  if (moreBtn) moreBtn.classList.toggle('active', moreTabs.has(tabId));

  document.querySelectorAll('.mobile-more-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });
}

function toggleMoreSheet() {
  const sheet = document.getElementById('mobile-more-sheet');
  const overlay = document.getElementById('mobile-more-overlay');
  if (!sheet) return;
  const open = sheet.classList.contains('open');
  sheet.classList.toggle('open', !open);
  overlay.classList.toggle('open', !open);
}

function closeMoreSheet() {
  document.getElementById('mobile-more-sheet')?.classList.remove('open');
  document.getElementById('mobile-more-overlay')?.classList.remove('open');
}

// Show commissioner entry in more sheet when the commissioner panel becomes visible
function watchCommissioner() {
  const navBtn = document.getElementById('commissioner-nav-btn');
  if (!navBtn) return;

  const update = () => {
    const commItem = document.getElementById('mobile-more-comm');
    if (!commItem) return;
    const visible = navBtn.style.display !== 'none' && !navBtn.hasAttribute('hidden');
    commItem.style.display = visible ? 'flex' : 'none';
  };

  new MutationObserver(update).observe(navBtn, {
    attributes: true,
    attributeFilter: ['style', 'hidden'],
  });

  update();
}

// ── Weekly score cards ──────────────────────────────────────────

function buildWeeklyCards() {
  if (!isMobile()) return;

  const table = document.getElementById('weekly-table');
  if (!table) return;

  // Remove stale cards
  document.getElementById('mobile-weekly-cards')?.remove();

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  if (!rows.length) return;

  // Detect whether the "Dates" column is present by counting <td> in the first data row
  const firstCells = rows[0]?.querySelectorAll('td');
  if (!firstCells || firstCells.length < 10) return;
  const hasDateCol = firstCells.length >= 15;
  const o = hasDateCol ? 1 : 0; // column offset

  const container = document.createElement('div');
  container.className = 'mobile-weekly-cards';
  container.id = 'mobile-weekly-cards';

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 10) return;

    // Column indices: Rnd(0) Wk(1) [Dates?] Manager(2+o) Pool(3+o) Bat(4+o) BatRk(5+o) Pit(6+o) PitRk(7+o) Total(8+o) TotRk(9+o) CumBat(10+o) CumPit(11+o) CumTot(12+o) PoolRk(13+o)
    const get = (i) => cells[i]?.textContent.trim() ?? '';

    const rnd = get(0);
    const wk = get(1);
    const manager = get(2 + o);
    const pool = get(3 + o);
    const bat = get(4 + o) || '—';
    const batRk = get(5 + o);
    const pit = get(6 + o) || '—';
    const pitRk = get(7 + o);
    const total = get(8 + o) || '—';
    const totRk = get(9 + o);
    const cumBat = get(10 + o) || '—';
    const cumPit = get(11 + o) || '—';
    const cumTot = get(12 + o) || '—';
    const poolRk = get(13 + o);

    const rank = parseInt(totRk, 10);
    const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : '';
    const rankDisplay = totRk || '—';

    const card = document.createElement('div');
    card.className = 'mobile-weekly-card';
    card.innerHTML = `
      <div class="mwc-summary">
        <div class="mwc-rank ${rankClass}">${rankDisplay}</div>
        <div class="mwc-info">
          <div class="mwc-name">${manager}</div>
          <div class="mwc-meta">${rnd} · ${wk}${pool ? ' · ' + pool : ''}</div>
        </div>
        <div class="mwc-score">
          <div class="mwc-total">${total}</div>
          <div class="mwc-bat-pit">🏏 ${bat} &nbsp;⚾ ${pit}</div>
        </div>
        <span class="mwc-chevron">▼</span>
      </div>
      <div class="mwc-detail">
        <div class="mwc-stat">
          <span class="mwc-stat-label">Batting Rank</span>
          <span class="mwc-stat-value">${batRk ? '#' + batRk : '—'}</span>
        </div>
        <div class="mwc-stat">
          <span class="mwc-stat-label">Pitching Rank</span>
          <span class="mwc-stat-value">${pitRk ? '#' + pitRk : '—'}</span>
        </div>
        <div class="mwc-stat">
          <span class="mwc-stat-label">Cum. Batting</span>
          <span class="mwc-stat-value">${cumBat}</span>
        </div>
        <div class="mwc-stat">
          <span class="mwc-stat-label">Cum. Pitching</span>
          <span class="mwc-stat-value">${cumPit}</span>
        </div>
        <div class="mwc-stat">
          <span class="mwc-stat-label">Cum. Total</span>
          <span class="mwc-stat-value">${cumTot}</span>
        </div>
        <div class="mwc-stat">
          <span class="mwc-stat-label">Pool Rank</span>
          <span class="mwc-stat-value">${poolRk ? '#' + poolRk : '—'}</span>
        </div>
      </div>
    `;

    card.querySelector('.mwc-summary').addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    container.appendChild(card);
  });

  // Insert after the hidden table wrapper
  const wrapper = table.closest('.table-wrapper') || table;
  wrapper.after(container);
}

function watchWeeklyTable() {
  const table = document.getElementById('weekly-table');
  if (!table) return;

  new MutationObserver(() => {
    if (isMobile()) buildWeeklyCards();
  }).observe(table, { childList: true, subtree: true });
}

// ── Init ────────────────────────────────────────────────────────

function init() {
  if (!isMobile()) return;
  buildMobileNav();
  watchWeeklyTable();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
