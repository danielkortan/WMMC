// ============================================================
// Shared Utility Functions
// ============================================================

import state from './state.js';
import { SEASON_SCHEDULE } from './state.js';
import { getSeasons } from './api.js';

// ---- Number/Date Formatting ----

export function fmt(val) {
  if (val == null || val === '' || val === 'None') return '-';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  return num % 1 === 0 ? num.toLocaleString() : num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export function fmtDec(val) {
  if (val == null || val === '') return '0';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ---- Pool Lookup ----

export function getPool(manager) {
  if (!state.data || !state.data.scoreboard || !state.data.scoreboard.pools) return '';
  for (const [pool, members] of Object.entries(state.data.scoreboard.pools)) {
    if (members.includes(manager)) return pool;
  }
  return '';
}

// ---- Select Helper ----

export function resetSelect(id, options, labelMap) {
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

// ---- Schedule Date Helpers ----

export function computeScheduleDates(asgDateStr) {
  const asg = new Date(asgDateStr + 'T12:00:00');
  const day = asg.getDay();
  const asgMonday = new Date(asg);
  asgMonday.setDate(asg.getDate() - ((day + 6) % 7));

  const week1Start = new Date(asgMonday);
  week1Start.setDate(asgMonday.getDate() - 70);

  const weeks = [];
  const cur = new Date(week1Start);

  for (let i = 0; i < 10; i++) {
    const start = new Date(cur);
    const end = new Date(cur);
    end.setDate(end.getDate() + 6);
    weeks.push({ start: fmtDateISO(start), end: fmtDateISO(end) });
    cur.setDate(cur.getDate() + 7);
  }

  cur.setDate(cur.getDate() + 7); // skip ASG break

  for (let i = 0; i < 6; i++) {
    const start = new Date(cur);
    const end = new Date(cur);
    end.setDate(end.getDate() + 6);
    weeks.push({ start: fmtDateISO(start), end: fmtDateISO(end) });
    cur.setDate(cur.getDate() + 7);
  }

  return weeks;
}

export function fmtDateISO(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

export function fmtShortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mo[d.getMonth()]} ${d.getDate()}`;
}

export function fmtDateRangeShort(startStr, endStr) {
  const s = new Date(startStr + 'T12:00:00');
  const e = new Date(endStr + 'T12:00:00');
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (s.getMonth() === e.getMonth()) {
    return `${mo[s.getMonth()]} ${s.getDate()} – ${e.getDate()}`;
  }
  return `${mo[s.getMonth()]} ${s.getDate()} – ${mo[e.getMonth()]} ${e.getDate()}`;
}

export function getScheduleDates() {
  const seasons = getSeasons();
  const sd = seasons[state.selectedSeason];
  return (sd && sd.schedule_dates) || null;
}

export function weekDateLabel(weekIndex) {
  const dates = getScheduleDates();
  if (!dates || !dates[weekIndex]) return '';
  return fmtDateRangeShort(dates[weekIndex].start, dates[weekIndex].end);
}

export function weekIndexFromKey(round, week) {
  return SEASON_SCHEDULE.findIndex(s => s.round === round && s.week === week);
}

export function getCurrentScoringPeriod(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const weekKeys = new Set();
  batting.forEach(b => { if (b.round && b.week) weekKeys.add(`${b.round}|${b.week}`); });
  pitching.forEach(p => { if (p.round && p.week) weekKeys.add(`${p.round}|${p.week}`); });

  if (weekKeys.size === 0) return null;

  const normalizeRound = r => r.replace(/P$/, '');

  let latestIdx = -1;
  let latestRound = null;
  let latestWeek = null;

  weekKeys.forEach(key => {
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

  const roundWeeks = SEASON_SCHEDULE.filter(s => s.round === latestRound);
  const weekNum = parseInt(latestWeek.replace('Week ', ''));
  const totalRoundWeeks = roundWeeks.length;

  let roundStartDate = null, roundEndDate = null;
  if (dates) {
    const roundIndices = SEASON_SCHEDULE
      .map((s, i) => s.round === latestRound ? i : -1)
      .filter(i => i >= 0);
    if (roundIndices.length > 0 && dates[roundIndices[0]] && dates[roundIndices[roundIndices.length - 1]]) {
      roundStartDate = dates[roundIndices[0]].start;
      roundEndDate = dates[roundIndices[roundIndices.length - 1]].end;
    }
  }

  const roundNames = {
    'PP1': 'Pool Play 1',
    'PP2': 'Pool Play 2',
    'QF': 'Quarterfinals',
    'SF': 'Semifinals',
    'Finals': 'Finals'
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

// ---- Online Users Helpers ----

export function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}
