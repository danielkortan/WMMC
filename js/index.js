// ============================================================
// Module index — re-exports all modules for easy importing
// ============================================================
// These modules extract the core logic from the monolithic app.js
// into testable, reusable units. The original app.js still serves
// as the main entry point for the browser, but these modules can
// be imported independently for testing and future refactoring.

export { default as state, SCORING, SEASON_SCHEDULE, GOOGLE_CLIENT_ID } from './state.js';
export { getSeasons, saveSeason, getManagers, saveManagers, fetchSeasons, fetchManagers, sendHeartbeat, fetchOnlineUsers, fetchVersion, fetchLoginPassword, getGSheetsConfig, saveGSheetsConfigToServer, triggerGSheetsSyncAPI, getGSheetsSyncStatus } from './api.js';
export { convertIP, calculateBattingScore, calculatePitchingScore, computeManagerScores, buildTeamWeekly, countUploadedWeeks } from './scoring.js';
export { fmt, fmtDec, formatDate, parseNum, getPool, resetSelect, computeScheduleDates, fmtDateISO, fmtShortDate, fmtDateRangeShort, getScheduleDates, weekDateLabel, weekIndexFromKey, getCurrentScoringPeriod, getInitials } from './utils.js';
export { parseCSVFile, parseCSVFileWithStats, parseCSVLine, findColumn, parseNum as csvParseNum } from './csv.js';
export { migrateRostersToWeekly, getWeekRoster, getAllRosteredPlayers, buildPlayerToManagerMap, findManagerForPlayerWeek, repairManagerAssignments } from './roster.js';
