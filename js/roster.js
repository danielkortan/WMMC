// ============================================================
// Roster Management Helpers
// ============================================================

import { SEASON_SCHEDULE } from './state.js';

// Migrate old flat rosters { batters:[], pitchers:[] } to per-week format
export function migrateRostersToWeekly(seasonData) {
  if (!seasonData || !seasonData.rosters) return;
  for (const [mgr, roster] of Object.entries(seasonData.rosters)) {
    if (Array.isArray(roster.batters) || Array.isArray(roster.pitchers)) {
      const batters = roster.batters || [];
      const pitchers = roster.pitchers || [];
      const newRoster = {};
      const uploadedWeeks = new Set();
      (seasonData.weekly_batting || []).forEach(b => { if (b.manager === mgr) uploadedWeeks.add(`${b.round}|${b.week}`); });
      (seasonData.weekly_pitching || []).forEach(p => { if (p.manager === mgr) uploadedWeeks.add(`${p.round}|${p.week}`); });
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

// Get the roster for a specific manager+week
export function getWeekRoster(seasonData, managerName, round, week) {
  const rosters = (seasonData && seasonData.rosters) || {};
  const mgrRoster = rosters[managerName] || {};
  const weekKey = `${round}|${week}`;
  return mgrRoster[weekKey] || { batters: [], pitchers: [] };
}

// Get ALL unique players across all weeks for a manager
export function getAllRosteredPlayers(seasonData, managerName) {
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

// Build a player-to-manager lookup from rosters
export function buildPlayerToManagerMap(seasonData) {
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
export function findManagerForPlayerWeek(seasonData, playerName, type, round, week) {
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

// Repair weekly data where 'manager' is null/unassigned
export function repairManagerAssignments(seasonData) {
  if (!seasonData || seasonData.status === 'completed') return false;

  const rosters = seasonData.rosters || {};
  let repaired = false;

  const playerToManager = {};
  for (const [managerName, mgrRoster] of Object.entries(rosters)) {
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
