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
} from './utils.js';
import { parseCSVLine, findColumn } from './csv.js';
import { computeSeasonAccolades } from './accolades.js';
import { oddsWindowForDate, formatOddsPct } from './playoffOdds.js';
import { orderWithSwapChains } from './rosterOrder.js';
import { checkSwapLimit, FREE_SWAP_REASON, PLAYOFF_LIMITED_REASONS } from './swaps.js';
import { rosterStatusAsOf, rosterStatusForManager, periodWeekKeys, managerWeekWindow } from './eligibility.js';
import {
  EMPTY_SCENARIO,
  buildSnapshot,
  buildScoringTable,
  isEmptyScenario,
  realRosterForRound,
  rosterOverrides,
  roundsPlayed,
  scoreScenario,
  scoringDiff,
  scoringKeys,
  weeksInRound,
  topPlayers,
  playerSuggestions,
  playerTypes,
  playerOwnership,
  playerGameLog,
  playerRoundTotals,
  explainPlayer,
} from './hypothetical.js';
import { seedFromPeriodTotals } from './seeding.js';
import { resolveBracket } from './bracket.js';
import { computePlayoffStatuses, playoffStatusLabel, statusKeyForPosition } from './playoffStatus.js';

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
  parseCSVLine,
  findColumn,
  computeSeasonAccolades,
  oddsWindowForDate,
  formatOddsPct,
  orderWithSwapChains,
  checkSwapLimit,
  FREE_SWAP_REASON,
  PLAYOFF_LIMITED_REASONS,
  rosterStatusAsOf,
  rosterStatusForManager,
  periodWeekKeys,
  managerWeekWindow,
  EMPTY_SCENARIO,
  buildSnapshot,
  buildScoringTable,
  isEmptyScenario,
  realRosterForRound,
  rosterOverrides,
  roundsPlayed,
  scoreScenario,
  scoringDiff,
  scoringKeys,
  weeksInRound,
  topPlayers,
  playerSuggestions,
  playerTypes,
  playerOwnership,
  playerGameLog,
  playerRoundTotals,
  explainPlayer,
  seedFromPeriodTotals,
  resolveBracket,
  computePlayoffStatuses,
  playoffStatusLabel,
  statusKeyForPosition,
});
