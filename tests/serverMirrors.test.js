import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Several pure helpers exist twice: canonically in js/ (unit-tested, imported by the browser)
// and again in server.js, which cannot import an ES module. CLAUDE.md's rule is "edit both",
// and the project's history is full of the bug that happens when someone edits one. This file
// is that rule, mechanized: it compares the two copies as text and fails on any drift.
//
// It deliberately runs no server code — it reads server.js as a string. If a mirror is
// intentionally being changed, change it in js/ too and this passes again.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Everything from `startMarker` to the end of the module, with the ESM `export` keywords
// stripped — which is exactly the transformation the server copy applies.
function canonicalTail(source, startMarker) {
  const at = source.indexOf(startMarker);
  assert.notEqual(at, -1, `canonical source is missing its start marker: ${startMarker}`);
  return source
    .slice(at)
    .replace(/^export /gm, '')
    .trimEnd();
}

// One top-level `function name(...) { ... }` declaration, located by brace matching so the
// comment above it (which legitimately differs between the two files) is not compared.
function extractFunction(source, name) {
  const at = source.search(new RegExp(`^(?:export )?function ${name}\\b`, 'm'));
  assert.notEqual(at, -1, `no top-level function ${name}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1).replace(/^export /, '');
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// One top-level `const NAME = { ... };` declaration, located by brace matching for the same
// reason extractFunction exists: the comment above it legitimately differs between the files.
function extractConstObject(source, name) {
  const at = source.search(new RegExp(`^(?:export )?const ${name}\\b`, 'm'));
  assert.notEqual(at, -1, `no top-level const ${name}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1).replace(/^export /, '');
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// app.js is the browser's copy of the scoring path. It is not a js/ module, so nothing guarded it —
// which is how the client came to score a row differently from the server without anyone noticing.
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

describe('app.js ↔ server.js scoring pairs', () => {
  // What ONE manager earned from ONE weekly row, as the BROWSER computes it. The client is not sent
  // daily rows, so it cannot clip to a window: it reads weekly_score, or the manager_scores split
  // when the server stored one. server.js carries a copy under a different name so
  // auditEligibilityDrift can reproduce what the scoreboard shows; if the two drift, that audit
  // starts answering about a client that does not exist.
  it('carries app.js rowScore as clientRowScore', () => {
    const client = extractFunction(SERVER, 'clientRowScore');
    const app = extractFunction(APP, 'rowScore');
    assert.equal(
      client.replace('function clientRowScore', 'function rowScore'),
      app,
      'server.js clientRowScore has drifted from app.js rowScore — the shadow audit would then be ' +
        'comparing against a client that does not exist'
    );
  });
});

describe('server.js mirrors of js/ modules', () => {
  it('carries js/history.js verbatim', () => {
    const canonical = canonicalTail(read('js/history.js'), 'export const WMMC_HISTORICAL_RESULTS');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/history.js — the historical results table and its helpers must be identical in both'
    );
  });

  it('carries js/anthropic.js verbatim', () => {
    const canonical = canonicalTail(read('js/anthropic.js'), "// The assistant's text from a Messages API response");
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/anthropic.js — the reply-shape helpers must be identical in both'
    );
  });

  it('carries js/playoffCommentary.js verbatim', () => {
    const canonical = canonicalTail(
      read('js/playoffCommentary.js'),
      '// A margin this big, this late, is not a deficit any more.'
    );
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/playoffCommentary.js — the commentary banks and rules must be identical in both'
    );
  });

  it('carries js/lateSubmission.js verbatim', () => {
    const canonical = canonicalTail(read('js/lateSubmission.js'), 'export const LATE_FALLBACK_FIRST_PITCH_HOUR_ET');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/lateSubmission.js — the late-submission effective-date rules must be identical in both'
    );
  });

  it('carries the swap effective-window rule from js/swaps.js verbatim', () => {
    const canonical = canonicalTail(read('js/swaps.js'), 'const ROUND_WINDOW_LABELS');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/swaps.js — checkSwapEffectiveWindow and its labels must be identical in both'
    );
  });

  // The Slack swap notification renders this label too, so the league can never see one name for
  // a swap type in the app and another in Slack.
  it('carries the swap reason labels from js/swaps.js verbatim', () => {
    const canonical = read('js/swaps.js');
    assert.equal(
      extractConstObject(SERVER, 'SWAP_REASON_LABELS'),
      extractConstObject(canonical, 'SWAP_REASON_LABELS'),
      'server.js has drifted from js/swaps.js — SWAP_REASON_LABELS must be identical in both'
    );
    assert.equal(
      extractFunction(SERVER, 'swapReasonLabel'),
      extractFunction(canonical, 'swapReasonLabel'),
      'server.js has drifted from js/swaps.js — swapReasonLabel must be identical in both'
    );
  });

  it('carries shortManagerNames from js/utils.js verbatim', () => {
    assert.equal(
      extractFunction(SERVER, 'shortManagerNames'),
      extractFunction(read('js/utils.js'), 'shortManagerNames')
    );
  });

  it('carries shortenManagerNamesInSlack from js/utils.js verbatim', () => {
    assert.equal(
      extractFunction(SERVER, 'shortenManagerNamesInSlack'),
      extractFunction(read('js/utils.js'), 'shortenManagerNamesInSlack')
    );
  });

  it('carries the NAME_EDGE the shortener is built on', () => {
    const line = "const NAME_EDGE = '[A-Za-z0-9]';";
    assert.ok(SERVER.includes(line), 'server.js is missing NAME_EDGE');
    assert.ok(read('js/utils.js').includes(line), 'js/utils.js is missing NAME_EDGE');
  });

  it('carries normalizeName from js/utils.js verbatim (the pre-existing pair)', () => {
    assert.equal(extractFunction(SERVER, 'normalizeName'), extractFunction(read('js/utils.js'), 'normalizeName'));
  });

  // The refused-correction message. Its whole value is that a human can tell an attribution
  // repair from a stat anomaly at a glance, so a server copy that has drifted into saying
  // something the tested copy does not say is worse than no message at all.
  it('carries js/corrections.js verbatim', () => {
    const canonical = canonicalTail(read('js/corrections.js'), 'export const CORRECTION_ROW_LIMIT');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/corrections.js — the correction classifier and its Slack text must be identical in both'
    );
  });

  it('carries js/roundPreview.js verbatim', () => {
    const canonical = canonicalTail(read('js/roundPreview.js'), 'export function fmtPreviewScore');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/roundPreview.js — the round-preview formatters must be identical in both'
    );
  });

  // The season's last Slack post. It goes out exactly once a year, so a drift here is one
  // nobody gets a second chance to notice before the league reads it.
  it('carries js/seasonRecap.js verbatim', () => {
    const canonical = canonicalTail(read('js/seasonRecap.js'), 'const TROPHY =');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/seasonRecap.js — the season-recap formatters must be identical in both'
    );
  });

  it('carries js/rollupDrift.js verbatim', () => {
    const canonical = canonicalTail(read('js/rollupDrift.js'), 'export const ROLLUP_DRIFT_NAG_DAYS');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/rollupDrift.js — the drift-flag recording, the alert cadence and the ' +
        'season-close gate must be identical in both'
    );
  });

  // The write-side keep-set. A server copy that has drifted into a NARROWER keep-set than the
  // tested one drops stat rows for players somebody actually rostered, which is the one direction
  // this filter must never fail in.
  it('carries js/statRetention.js verbatim', () => {
    const canonical = canonicalTail(read('js/statRetention.js'), 'export const STAT_RETENTION_MODES');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/statRetention.js — the stat-row keep-set must be identical in both'
    );
  });

  // The backup's contents. A server copy that has drifted into a NARROWER key list silently stops
  // backing something up, and the way you find out is the day you need it.
  it('carries js/backupSet.js verbatim', () => {
    const canonical = canonicalTail(read('js/backupSet.js'), 'export const BACKUP_FORMAT');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/backupSet.js — the irreplaceable-field lists and the diff must be identical in both'
    );
  });

  // The derivation the core scoring invariant describes. If the server copy drifts, the scoreboard
  // and the drift audit stop agreeing about who was rostered — which is the bug class 43 of the 98
  // MEMORY entries are made of.
  it('carries js/rosterWindows.js verbatim', () => {
    const canonical = canonicalTail(read('js/rosterWindows.js'), 'export function weekRosterWindows');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/rosterWindows.js — the roster-window derivation must be identical in both'
    );
  });

  it('carries js/attribution.js verbatim', () => {
    const canonical = canonicalTail(read('js/attribution.js'), 'export function chooseOwner');
    assert.ok(
      SERVER.includes(canonical),
      'server.js has drifted from js/attribution.js — the weekly-row attribution repair must be identical in both'
    );
  });

  // The elimination ladder. lastRoundPlayed is the one that encodes "the semifinal knocks
  // nobody out of the schedule", so a drift here would put the 3rd-place game's two managers
  // back where this pair was added to get them out of: unable to submit a Finals roster.
  for (const name of ['lastRoundPlayed', 'isManagerActiveInRound', 'isManagerInRound']) {
    it(`carries ${name} from js/eligibility.js verbatim`, () => {
      assert.equal(
        extractFunction(SERVER, name),
        extractFunction(read('js/eligibility.js'), name),
        `server.js has drifted from js/eligibility.js in ${name} — the elimination ladder must be identical in both`
      );
    });
  }

  // The odds engine is the oldest untested mirror pair in the repo. These are the functions
  // whose two copies are byte-identical — the rest of the engine (computeTeamQualityFactors,
  // gameFactor) differs only in the name of the local clamp helper, which server.js has to
  // call oddsClamp because a `clamp` already lives at its top level.
  for (const name of [
    'bracketOddsWindowForDate',
    'expectedAppearanceRate',
    'projectManager',
    'simulateBracketOdds',
    'simulatePlayoffOdds',
    'playerGameRate',
    'meanVariance',
    'currentQualification',
    'makeNormalSampler',
    'formatOddsPct',
  ]) {
    it(`carries ${name} from js/playoffOdds.js verbatim`, () => {
      assert.equal(
        extractFunction(SERVER, name),
        extractFunction(read('js/playoffOdds.js'), name),
        `server.js has drifted from js/playoffOdds.js in ${name} — the odds engine must be identical in both`
      );
    });
  }
});
