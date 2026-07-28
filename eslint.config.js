// ESLint flat config (ESLint 9+ no longer reads .eslintrc.json).
// CommonJS to match server.js — this package is CJS (see package.json `main`).
//
// Mirrors the previous .eslintrc.json:
//   - app.js + js/   : browser + node, ES modules
//   - server.js      : node only, CommonJS script
//   - tests/**/*.js  : node, ES modules
// Keep the rules block in sync with the project's "definition of done".

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

// Globals defined in app.js / js/ that are referenced across files (the
// SCORING/SEASON_SCHEDULE pair, scoring helpers, and CDN/SDK objects).
const projectGlobals = {
  Chart: 'readonly',
  google: 'readonly',
  SCORING: 'readonly',
  SEASON_SCHEDULE: 'readonly',
  convertIP: 'readonly',
  calculateBattingScore: 'readonly',
  calculatePitchingScore: 'readonly',
  enrichTeamWeekly: 'readonly',
  computeSeasonAccolades: 'readonly',
  esc: 'readonly',
  jsStr: 'readonly',
  parseNum: 'readonly',
  fmt: 'readonly',
  fmtDec: 'readonly',
  getInitials: 'readonly',
  fmtDateISO: 'readonly',
  normalizeName: 'readonly',
  parseServerTimestamp: 'readonly',
  parseCSVLine: 'readonly',
  findColumn: 'readonly',
  oddsWindowForDate: 'readonly',
  formatOddsPct: 'readonly',
  orderWithSwapChains: 'readonly',
  checkSwapLimit: 'readonly',
  rosterStatusAsOf: 'readonly',
};

const projectRules = {
  // caughtErrors:"none" preserves the ESLint 8 default — ESLint 9+ changed it to
  // "all", which would newly flag every unused `catch (e)` binding.
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-console': 'off',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'warn',
  curly: ['warn', 'multi-line'],
};

module.exports = [
  js.configs.recommended,
  prettier,
  // Base: applies to everything ESLint is pointed at. ES modules by default.
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: projectRules,
  },
  // Frontend: browser + node globals.
  {
    files: ['app.js', 'js/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...projectGlobals },
    },
  },
  // Backend: node only, CommonJS.
  {
    files: ['server.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...projectGlobals },
    },
  },
  // Tests: node, ES modules.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...projectGlobals },
    },
  },
];
