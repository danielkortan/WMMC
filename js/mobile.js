// Mobile experience (rebuilt): bottom nav + "more" sheet, and the
// Scoreboard landing transforms (manager rows → cards, tap-to-expand
// Pool Play 1 / Pool Play 2 sections). Other tabs use the desktop layout.

const MOBILE_BREAKPOINT = 768;

function isMobile() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

// ── Bottom nav + more sheet ───────────────────────────────────────

function buildMobileNav() {
  const primaryTabs = [
    { icon: '⚾', label: 'Scoreboard', tab: 'dashboard' },
    { icon: '⚡', label: 'Live', tab: 'live' },
    { icon: '📋', label: 'Roster', tab: 'my-roster' },
    { icon: '📊', label: 'Scores', tab: 'weekly' },
  ];

  const moreTabs = [
    { icon: '🔁', label: 'Swap Log', tab: 'swap-log' },
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

// ── Banner: auto-fit the reigning-champion name ───────────────────
// The title is fixed-width and the trophy is fixed, so the champion block has
// a fixed amount of room. Shrink ONLY the champion name's font until it fits
// that room — a long name scales down instead of pushing, wrapping, or
// resizing anything else in the banner.
function fitBannerChampName() {
  if (!isMobile()) return;
  const banner = document.getElementById('champion-banner');
  const nameEl = banner && banner.querySelector('.banner-champ-name');
  if (!nameEl) return;

  // Reset to the CSS (clamp) size, then measure once layout settles.
  nameEl.style.fontSize = '';
  requestAnimationFrame(() => {
    let size = parseFloat(getComputedStyle(nameEl).fontSize) || 16;
    const MIN = 10;
    let guard = 60;
    // scrollWidth is the text's intrinsic width; clientWidth is the bounded box.
    while (nameEl.scrollWidth > nameEl.clientWidth + 0.5 && size > MIN && guard-- > 0) {
      size -= 0.5;
      nameEl.style.fontSize = size + 'px';
    }
  });
}

function watchBanner() {
  const banner = document.getElementById('champion-banner');
  if (!banner) return;

  // Re-fit whenever the banner content is (re)rendered. Observe childList only
  // so our own inline font-size tweaks (attribute changes) don't re-trigger it.
  new MutationObserver(() => fitBannerChampName()).observe(banner, {
    childList: true,
    subtree: true,
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitBannerChampName, 150);
  });

  fitBannerChampName();
  // Re-fit after web fonts finish loading (metrics can shift).
  setTimeout(fitBannerChampName, 500);
}

// ── Scoreboard landing transforms ─────────────────────────────────

// Tag manager summary rows so the CSS can lay them out as flex cards
// ([rank] [name] [score]) and color the top-3 rank cells.
function transformScoreboardTables() {
  if (!isMobile()) return;

  const rows = document.querySelectorAll(
    '#scoreboard-content .sb-manager-row,' +
      ' #scoreboard-content .pool-card-body table tbody tr,' +
      ' #scoreboard-content .sb-period table tbody tr'
  );

  rows.forEach((row) => {
    // Skip rows that live inside an expanded player-detail panel.
    if (row.closest('.mgr-detail-panel') || row.closest('.sb-manager-detail-row')) return;
    row.classList.add('mob-sbrow');

    const rankCell = row.querySelector('td:first-child');
    if (rankCell && !rankCell.dataset.mobRanked) {
      const n = parseInt(rankCell.textContent.trim(), 10);
      const cls = n === 1 ? 'rank-1' : n === 2 ? 'rank-2' : n === 3 ? 'rank-3' : '';
      if (cls) rankCell.classList.add(cls);
      rankCell.dataset.mobRanked = '1';
    }
  });
}

// Default the stacked PP1 / PP2 sections to "current period open, other
// collapsed". Runs once per render (guarded) so it doesn't fight a user's
// manual taps until the scoreboard is re-rendered.
function applyMobilePoolPlayDefaults() {
  if (!isMobile()) return;

  const footer = document.querySelector('#champion-banner .banner-footer');
  const openPeriod = footer && /Pool Play 2/i.test(footer.textContent) ? 'pp2' : 'pp1';

  ['pp1', 'pp2'].forEach((p) => {
    const sec = document.getElementById('sb-' + p);
    if (!sec || sec.dataset.mobInit === '1') return;
    sec.dataset.mobInit = '1';
    sec.classList.toggle('mob-pp-collapsed', p !== openPeriod);
  });
}

// Tap a period header (Pool Play 1 / 2) to collapse the whole period;
// tap a pool header to collapse that pool. Delegated so it survives the
// scoreboard's frequent re-renders. Manager rows keep their own toggle.
function setupPoolPlayToggles() {
  document.addEventListener('click', (e) => {
    if (!isMobile()) return;
    if (!e.target.closest('#scoreboard-content')) return;

    const poolHeader = e.target.closest('.pool-card-header');
    if (poolHeader) {
      poolHeader.closest('.pool-card')?.classList.toggle('mob-pool-collapsed');
      return;
    }

    const periodHeader = e.target.closest('.pool-period-header');
    if (periodHeader) {
      periodHeader.closest('.sb-period')?.classList.toggle('mob-pp-collapsed');
    }
  });
}

function watchScoreboard() {
  const container = document.getElementById('scoreboard-content');
  if (!container) return;

  const run = () => {
    if (!isMobile()) return;
    transformScoreboardTables();
    applyMobilePoolPlayDefaults();
  };

  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.type === 'childList')) run();
  }).observe(container, { childList: true, subtree: true });

  run();
}

// ── Init ──────────────────────────────────────────────────────────

function init() {
  if (!isMobile()) return;
  buildMobileNav();
  watchBanner();
  setupPoolPlayToggles();
  watchScoreboard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
