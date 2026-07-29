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
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
  enrichTeamWeekly,
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
import { rosterStatusAsOf, rosterStatusForManager, periodWeekKeys } from './eligibility.js';

// Expose helpers globally for app.js (classic script) to consume.
Object.assign(window, {
  SCORING,
  SEASON_SCHEDULE,
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
  enrichTeamWeekly,
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
});
