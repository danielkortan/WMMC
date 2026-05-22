// Mobile experience: bottom nav, more sheet, weekly score cards,
// scoreboard + live table card layout

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

  const overlay = document.createElement('div');
  overlay.className = 'mobile-more-overlay';
  overlay.id = 'mobile-more-overlay';
  overlay.addEventListener('click', closeMoreSheet);
  document.body.appendChild(overlay);

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

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isMobile()) syncActiveState(btn.dataset.tab, MORE_TAB_IDS);
    });
  });

  const saved = localStorage.getItem('wmmc_active_tab') || 'dashboard';
  syncActiveState(saved, MORE_TAB_IDS);

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

// ── Live detail: enforce horizontal layout via inline styles ─────
// CSS flex alone isn't winning against the table layout context,
// so we patch inline styles directly after expand events.
function watchLiveDetails() {
  const container = document.getElementById('live-managers');
  if (!container) return;

  const applyFlex = (row) => {
    if (row.style.display === 'none') return;
    const panel = row.querySelector('.mgr-detail-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '0.75rem';
    panel.style.overflow = 'visible';
    panel.style.padding = '0.5rem';
    panel.style.background = '#13132a';
    row.querySelectorAll('.live-mgr-detail-section').forEach((s) => {
      s.style.flex = 'none';
      s.style.width = '100%';
      s.style.minWidth = '0';
      s.style.overflow = 'visible';
    });
    row.querySelectorAll('.live-mgr-detail-section .table-wrapper').forEach((w) => {
      w.style.overflow = 'auto';
    });
  };

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target.classList?.contains('live-mgr-detail-row')) {
        applyFlex(m.target);
      } else if (m.type === 'childList') {
        // Live data re-rendered — patch all currently-expanded detail rows
        container.querySelectorAll('.live-mgr-detail-row').forEach(applyFlex);
      }
    }
  }).observe(container, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
    subtree: true,
  });
}

// ── Pool Play: stack PP1/PP2 below PP-Overall on mobile ──────────
function stackPoolPlayPeriods() {
  const overall = document.getElementById('sb-pp-overall');
  if (!overall || overall.style.display === 'none') return;

  [
    { id: 'sb-pp1', label: 'Pool Play 1' },
    { id: 'sb-pp2', label: 'Pool Play 2' },
  ].forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.style.display === 'none') el.style.display = '';
    if (!el.querySelector('.mob-section-header')) {
      const hdr = document.createElement('h3');
      hdr.className = 'mob-section-header';
      hdr.textContent = label;
      el.prepend(hdr);
    }
  });
}

// ── Scoreboard table card transformation ─────────────────────────

// Attach a score-tap breakdown row to one manager row.
// Columns are identified by counting from the right:
//   last = total, last-2 = pitching, last-3 = batting
// Tables with >7 columns (e.g. the 9-col historical overall) are skipped.
function attachScoreTap(row) {
  if (row.dataset.mobScoreTap) return;
  row.dataset.mobScoreTap = '1';

  const cells = row.querySelectorAll('td');
  const n = cells.length;
  if (n < 4 || n > 7) return; // skip trivial or complex tables

  const bat = cells[n - 3]?.textContent.trim() || '—';
  const pit = cells[n - 2]?.textContent.trim() || '—';
  const totalCell = cells[n - 1];
  if (!totalCell) return;

  const breakdownRow = document.createElement('tr');
  breakdownRow.className = 'mob-score-breakdown-row';
  breakdownRow.innerHTML = `<td><span>🏏 Bat &nbsp;<strong>${bat}</strong></span><span>⚾ Pit &nbsp;<strong>${pit}</strong></span></td>`;

  // Insert between this row and the detail row (if any)
  const next = row.nextElementSibling;
  if (next) {
    next.before(breakdownRow);
  } else {
    row.after(breakdownRow);
  }

  totalCell.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent row-level player-list toggle
    const isOpen = breakdownRow.classList.contains('open');
    breakdownRow.classList.toggle('open', !isOpen);

    // If player list is open, close it when showing score breakdown
    if (!isOpen) {
      const detailRow = breakdownRow.nextElementSibling;
      if (detailRow?.classList.contains('sb-manager-detail-row') && detailRow.style.display !== 'none') {
        detailRow.style.display = 'none';
        const mgrKey = detailRow.id?.replace('mgr-detail-', '');
        const arrow = mgrKey ? document.getElementById('sb-arrow-' + mgrKey) : null;
        if (arrow) arrow.innerHTML = '&#9660;';
      }
    }
  });
}

function transformScoreboardTables() {
  if (!isMobile()) return;

  // Active season: rows already have sb-manager-row class + onclick handlers
  document.querySelectorAll('#scoreboard-content .sb-manager-row').forEach((row) => {
    row.classList.add('mob-sbrow');
    attachScoreTap(row);
  });

  // Historical season: plain tbody rows inside pool-card tables
  document.querySelectorAll('#scoreboard-content .pool-card-body table tbody tr').forEach((row) => {
    if (row.classList.contains('mob-sbrow')) return;
    row.classList.add('mob-sbrow');
    attachScoreTap(row);
  });

  // Playoff period tables (QF/SF/Finals) inside active scoreboard — plain tbody rows
  document.querySelectorAll('#scoreboard-content .sb-period table tbody tr').forEach((row) => {
    if (row.classList.contains('sb-manager-row') || row.classList.contains('mob-sbrow')) return;
    row.classList.add('mob-sbrow');
    attachScoreTap(row);
  });

  // Color rank cells for top 3 by reading the text content
  document.querySelectorAll('#scoreboard-content .mob-sbrow td:first-child').forEach((rankCell) => {
    const n = parseInt(rankCell.textContent.trim(), 10);
    if (n === 1) rankCell.classList.add('rank-1');
    else if (n === 2) rankCell.classList.add('rank-2');
    else if (n === 3) rankCell.classList.add('rank-3');
  });
}

function watchScoreboard() {
  const container = document.getElementById('scoreboard-content');
  if (!container) return;

  new MutationObserver((mutations) => {
    if (!isMobile()) return;
    const hasNewContent = mutations.some((m) => m.type === 'childList');
    const hasPeriodSwitch = mutations.some((m) => m.type === 'attributes' && m.target.classList?.contains('sb-period'));
    if (hasNewContent) transformScoreboardTables();
    if (hasNewContent || hasPeriodSwitch) stackPoolPlayPeriods();
  }).observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
}

// ── Weekly score cards ──────────────────────────────────────────

function buildWeeklyCards() {
  if (!isMobile()) return;

  const table = document.getElementById('weekly-table');
  if (!table) return;

  document.getElementById('mobile-weekly-cards')?.remove();

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  if (!rows.length) return;

  const firstCells = rows[0]?.querySelectorAll('td');
  if (!firstCells || firstCells.length < 10) return;
  const hasDateCol = firstCells.length >= 15;
  const o = hasDateCol ? 1 : 0;

  const container = document.createElement('div');
  container.className = 'mobile-weekly-cards';
  container.id = 'mobile-weekly-cards';

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 10) return;

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

    const card = document.createElement('div');
    card.className = 'mobile-weekly-card';
    card.innerHTML = `
      <div class="mwc-summary">
        <div class="mwc-rank ${rankClass}">${totRk || '—'}</div>
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
  watchLiveDetails();
  watchWeeklyTable();
  watchScoreboard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
