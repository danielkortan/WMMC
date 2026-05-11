// ============================================================
// WMMC — Frontend module entry point
// ============================================================
// Imports every public helper and attaches it to `window` so the (currently
// classic-script) app.js can resolve bare references like `fmt(x)` via the
// global scope chain. This is the bridge during the gradual migration of
// app.js into ES modules — once a function is exported here AND deleted
// from app.js, the live app will use the module version.

import { SCORING, SEASON_SCHEDULE, convertIP, calculateBattingScore, calculatePitchingScore } from './scoring.js';
import { esc, jsStr, parseNum, fmt, fmtDec, getInitials, fmtDateISO } from './utils.js';
import { parseCSVLine, findColumn } from './csv.js';

// Expose helpers globally for app.js (classic script) to consume.
Object.assign(window, {
  SCORING,
  SEASON_SCHEDULE,
  convertIP,
  calculateBattingScore,
  calculatePitchingScore,
  esc,
  jsStr,
  parseNum,
  fmt,
  fmtDec,
  getInitials,
  fmtDateISO,
  parseCSVLine,
  findColumn,
});
