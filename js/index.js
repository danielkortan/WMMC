// ============================================================
// WMMC — Frontend module entry point
// ============================================================
// Imports every public helper and attaches it to `window` so the (currently
// classic-script) app.js can resolve bare references like `fmt(x)` via the
// global scope chain. This is the bridge during the gradual migration of
// app.js into ES modules — once a function is exported here AND deleted
// from app.js, the live app will use the module version.

import {
  SCORING,
  SEASON_SCHEDULE,
  ROUND_LABELS,
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
  enrichTeamWeekly,
  roundShortLabel,
  weekLabel,
} from './scoring.js';
import {
  esc,
  jsStr,
  parseNum,
  fmt,
  fmtDec,
  getInitials,
  fmtDateISO,
  normalizeName,
  parseServerTimestamp,
  shortManagerNames,
} from './utils.js';
import { parseCSVLine, findColumn } from './csv.js';
import { computeSeasonAccolades } from './accolades.js';
import { oddsWindowForDate, bracketOddsWindowForDate, formatOddsPct } from './playoffOdds.js';
import { orderWithSwapChains } from './rosterOrder.js';
import { checkSwapLimit, checkSwapEffectiveWindow, swapReasonLabel } from './swaps.js';
import {
  addDaysISO,
  periodBounds,
  nextViableEffectiveDate,
  validateForgivenessDate,
  isSubmissionLate,
  submissionLateState,
  lateSubmissionActions,
} from './lateSubmission.js';
import {
  periodStartForRound,
  rosterStatusAsOf,
  rosterStatusForManager,
  periodWeekKeys,
  managerWeekWindow,
  lastRoundPlayed,
  isManagerActiveInRound,
  FINALS_GAME_LABELS,
  finalsGameFor,
  finalsGameLabel,
} from './eligibility.js';
import {
  buildSnapshot,
  realRosterForRound,
  rosterOverrides,
  roundsPlayed,
  scoreScenario,
  scoringDiff,
  scoringKeys,
  lastKnownRoster,
  scenarioStatCoverage,
  playerSuggestions,
  playerTypes,
  explainPlayer,
} from './hypothetical.js';
import { seedFromPeriodTotals } from './seeding.js';
import { computePlayoffStatuses, playoffStatusLabel, statusKeyForPosition } from './playoffStatus.js';
import {
  WMMC_HISTORICAL_RESULTS,
  HISTORICAL_NAME_ALIASES,
  canonicalManagerName,
  exitStageForPlace,
  managerPlayoffHistory,
} from './history.js';

// Expose helpers globally for app.js (classic script) to consume.
Object.assign(window, {
  SCORING,
  SEASON_SCHEDULE,
  ROUND_LABELS,
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
  enrichTeamWeekly,
  roundShortLabel,
  weekLabel,
  esc,
  jsStr,
  parseNum,
  fmt,
  fmtDec,
  getInitials,
  fmtDateISO,
  normalizeName,
  parseServerTimestamp,
  shortManagerNames,
  parseCSVLine,
  findColumn,
  computeSeasonAccolades,
  oddsWindowForDate,
  bracketOddsWindowForDate,
  formatOddsPct,
  orderWithSwapChains,
  checkSwapLimit,
  checkSwapEffectiveWindow,
  swapReasonLabel,
  addDaysISO,
  periodBounds,
  nextViableEffectiveDate,
  validateForgivenessDate,
  isSubmissionLate,
  submissionLateState,
  lateSubmissionActions,
  periodStartForRound,
  rosterStatusAsOf,
  rosterStatusForManager,
  periodWeekKeys,
  managerWeekWindow,
  lastRoundPlayed,
  isManagerActiveInRound,
  FINALS_GAME_LABELS,
  finalsGameFor,
  finalsGameLabel,
  buildSnapshot,
  realRosterForRound,
  rosterOverrides,
  roundsPlayed,
  scoreScenario,
  scoringDiff,
  scoringKeys,
  lastKnownRoster,
  scenarioStatCoverage,
  playerSuggestions,
  playerTypes,
  explainPlayer,
  seedFromPeriodTotals,
  computePlayoffStatuses,
  playoffStatusLabel,
  statusKeyForPosition,
  WMMC_HISTORICAL_RESULTS,
  HISTORICAL_NAME_ALIASES,
  canonicalManagerName,
  exitStageForPlace,
  managerPlayoffHistory,
});
