// ============================================================
// Scoring Engine
// ============================================================

import { SCORING } from './state.js';
import { getManagers } from './api.js';

// Convert IP from baseball notation to decimal: .1 -> .33, .2 -> .66
export function convertIP(rawIP) {
  const str = String(rawIP);
  const dotIndex = str.indexOf('.');
  if (dotIndex === -1) return rawIP;
  const whole = parseInt(str.substring(0, dotIndex)) || 0;
  const frac = str.substring(dotIndex + 1);
  if (frac === '1') return Math.round((whole + 0.33) * 100) / 100;
  if (frac === '2') return Math.round((whole + 0.66) * 100) / 100;
  return rawIP;
}

export function calculateBattingScore(stats) {
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

export function calculatePitchingScore(stats) {
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

export function computeManagerScores(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  const managerMap = {};
  batting.forEach(b => {
    const mgr = b.manager;
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

export function buildTeamWeekly(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];
  const managers = getManagers();

  const managerPool = {};
  managers.forEach(m => { if (m.pool) managerPool[m.name] = 'Pool ' + m.pool; });

  const key = (r, w, m) => `${r}|${w}|${m}`;
  const map = {};

  batting.forEach(b => {
    const mgr = b.manager;
    if (!mgr) return;
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

export function countUploadedWeeks(seasonData) {
  const batting = seasonData.weekly_batting || [];
  const weeks = new Set();
  batting.forEach(b => weeks.add(`${b.round}|${b.week}`));
  return weeks.size;
}
