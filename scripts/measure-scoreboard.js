#!/usr/bin/env node
//
// Time the scoreboard's scoring pass, and print the per-manager totals it produces.
//
// Two jobs, both of which CLAUDE.md asks for and neither of which the browser makes easy:
//
//  1. Answer "how close is this season to the wall?" with a number instead of a hunch. The
//     scoreboard calls managerWeekSubtotal once per scheduled week per manager per stat type —
//     256 times for a 16-week, 8-manager season — and each call used to walk the entire weekly
//     row array. This says what that actually costs at a given season size.
//
//  2. Produce the before/after per-manager totals comparison that any change touching managers,
//     roster windows, swaps or scoring has to be vetted with (SAVE_HARDENING_PLAN.md section 7).
//     Run it on both sides of a change with --json and diff the files: the totals must be
//     byte-identical unless the change is deliberately a scoring change.
//
// Usage:
//   node scripts/measure-scoreboard.js --db db.json --season 2026
//   node scripts/measure-scoreboard.js --batters 1340 --pitchers 550 --swaps 4
//   node scripts/measure-scoreboard.js --db db.json --json before.json
//
// It loads the real app.js into a VM with enough browser stubs to reach the scoring functions.
// There is no build step and no DOM here — only the pure scoring path is exercised.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { batters: 1340, pitchers: 550, swaps: 4 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--season') out.season = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--batters') out.batters = Number(argv[++i]);
    else if (a === '--pitchers') out.pitchers = Number(argv[++i]);
    else if (a === '--swaps') out.swaps = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// ---- browser stubs ----------------------------------------------------------
function stubEl() {
  return {
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    children: [],
    value: '',
    innerHTML: '',
    textContent: '',
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    insertAdjacentHTML() {},
    focus() {},
    click() {},
    remove() {},
  };
}

async function loadApp() {
  const store = {
    _d: {},
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    },
    clear() {
      this._d = {};
    },
    key: () => null,
    length: 0,
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      getElementById: () => stubEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => stubEl(),
      addEventListener() {},
      removeEventListener() {},
      body: stubEl(),
      documentElement: stubEl(),
      head: stubEl(),
      readyState: 'complete',
      cookie: '',
    },
    localStorage: store,
    sessionStorage: store,
    navigator: { userAgent: 'node', language: 'en-US' },
    location: { href: 'http://localhost/', search: '', hash: '', pathname: '/', origin: 'http://localhost' },
    history: { replaceState() {}, pushState() {} },
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    alert() {},
    confirm: () => false,
    prompt: () => null,
    Chart: function () {},
    MutationObserver: function () {
      return { observe() {}, disconnect() {} };
    },
    performance,
    URL,
    URLSearchParams,
    structuredClone,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // js/index.js bridges the ESM modules onto window in the browser; do the same here.
  for (const m of fs.readdirSync(path.join(REPO, 'js'))) {
    if (!m.endsWith('.js') || m === 'index.js' || m === 'mobile.js') continue;
    const ns = await import('file://' + path.join(REPO, 'js', m));
    for (const [k, v] of Object.entries(ns)) sandbox[k] = v;
  }
  try {
    vm.runInContext(fs.readFileSync(path.join(REPO, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  } catch {
    // app.js finishes by wiring up the DOM and calling loadData(); neither exists here and
    // neither is needed — the scoring functions are already defined by then.
  }
  if (typeof sandbox.managerWeekSubtotal !== 'function') {
    throw new Error('managerWeekSubtotal not reachable — app.js layout changed?');
  }
  return sandbox;
}

// ---- synthetic season -------------------------------------------------------
// A league-shaped season at an arbitrary size: 8 managers in two pools, a fresh 15/6 roster per
// submission period, weekly rows for the whole player pool (most of it unrostered, as in
// production), and `swaps` approved swaps per manager per week — each leaving a dropped entry in
// roster_dates, which is what wasDroppedBefore has to walk.
function synthSeason({ batters, pitchers, swaps: swapsPerWeek }, SEASON_SCHEDULE) {
  const managers = Array.from({ length: 8 }, (_, i) => ({
    name: `Manager ${i + 1}`,
    email: `m${i + 1}@example.test`,
    active: true,
    pool: i < 4 ? 'Pool A' : 'Pool B',
    commissioner: i === 0,
  }));

  const schedule_dates = [];
  let d = new Date('2026-03-26T00:00:00Z');
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    schedule_dates.push({
      start: d.toISOString().slice(0, 10),
      end: new Date(d.getTime() + 6 * 864e5).toISOString().slice(0, 10),
    });
    d = new Date(d.getTime() + 7 * 864e5);
  }

  const batterNames = Array.from({ length: batters }, (_, i) => `Batter ${i + 1}`);
  const pitcherNames = Array.from({ length: pitchers }, (_, i) => `Pitcher ${i + 1}`);
  const rounds = [...new Set(SEASON_SCHEDULE.map((s) => s.round))];

  const rosters = {};
  const roster_dates = {};
  const allSwaps = [];
  const batOwner = {};
  const pitOwner = {};

  managers.forEach((m, mi) => {
    rosters[m.name] = {};
    roster_dates[m.name] = {};
    rounds.forEach((round, ri) => {
      const bats = batterNames.slice(mi * 15 + ri * 200, mi * 15 + ri * 200 + 15);
      const pits = pitcherNames.slice(mi * 6 + ri * 100, mi * 6 + ri * 100 + 6);
      for (const p of bats) batOwner[`${round}|${p}`] = m.name;
      for (const p of pits) pitOwner[`${round}|${p}`] = m.name;
      SEASON_SCHEDULE.forEach((sw, idx) => {
        if (sw.round !== round) return;
        const key = `${round}|${sw.week}`;
        rosters[m.name][key] = { batters: bats, pitchers: pits };
        const dates = {};
        for (const p of [...bats, ...pits]) dates[p] = { add_date: schedule_dates[idx].start };
        roster_dates[m.name][key] = dates;
      });
    });

    SEASON_SCHEDULE.forEach((sw, idx) => {
      const key = `${sw.round}|${sw.week}`;
      for (let s = 0; s < swapsPerWeek; s++) {
        const out = `Batter ${((mi * 97 + idx * 13 + s * 7) % batterNames.length) + 1}`;
        const inn = `Batter ${((mi * 89 + idx * 17 + s * 11) % batterNames.length) + 1}`;
        const dates = roster_dates[m.name][key] || (roster_dates[m.name][key] = {});
        dates[out] = { add_date: schedule_dates[Math.max(0, idx - 1)].start, drop_date: schedule_dates[idx].start };
        dates[inn] = { add_date: schedule_dates[idx].start };
        allSwaps.push({
          manager: m.name,
          status: 'approved',
          week_key: key,
          player_in: inn,
          player_out: out,
          swap_date: schedule_dates[idx].start,
        });
      }
    });
  });

  const weekly_batting = [];
  const weekly_pitching = [];
  for (const sw of SEASON_SCHEDULE) {
    batterNames.forEach((p, i) => {
      weekly_batting.push({
        round: sw.round,
        week: sw.week,
        manager: batOwner[`${sw.round}|${p}`] || null,
        batter: p,
        weekly_score: ((i * 7) % 43) + 1,
      });
    });
    pitcherNames.forEach((p, i) => {
      weekly_pitching.push({
        round: sw.round,
        week: sw.week,
        manager: pitOwner[`${sw.round}|${p}`] || null,
        pitcher: p,
        weekly_score: ((i * 5) % 37) + 1,
      });
    });
  }

  return {
    managers,
    sd: {
      name: 'Synthetic',
      year: '2026',
      status: 'active',
      schedule_dates,
      rosters,
      roster_dates,
      swaps: allSwaps,
      weekly_batting,
      weekly_pitching,
      daily_batting: [],
      daily_pitching: [],
      batters_pool: batterNames,
      pitchers_pool: pitcherNames,
      batters_team: {},
      pitchers_team: {},
    },
  };
}

// ---- run --------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      fs
        .readFileSync(__filename, 'utf8')
        .split('\n')
        .slice(2, 24)
        .join('\n')
        .replace(/^\/\/ ?/gm, '')
    );
    return;
  }

  const app = await loadApp();
  const SEASON_SCHEDULE = app.SEASON_SCHEDULE;

  let managers;
  let sd;
  let source;
  if (args.db) {
    const db = JSON.parse(fs.readFileSync(args.db, 'utf8'));
    const season =
      args.season ||
      Object.keys(db.seasons || {})
        .sort()
        .pop();
    sd = (db.seasons || {})[season];
    if (!sd) throw new Error(`season ${season} not found in ${args.db}`);
    // Managers come from one place only: the commissioner page (db.managers).
    managers = (db.managers || []).filter((m) => m.active !== false && m.pool);
    source = `${args.db} season ${season}`;
  } else {
    ({ managers, sd } = synthSeason(args, SEASON_SCHEDULE));
    source = `synthetic (${args.batters} batters / ${args.pitchers} pitchers / ${args.swaps} swaps per manager-week)`;
  }

  app.getManagers = () => managers;

  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const calls = SEASON_SCHEDULE.length * managers.length * 2;

  console.log(`source:   ${source}`);
  console.log(
    `season:   ${batting.length + pitching.length} weekly rows · ${managers.length} managers · ` +
      `${(sd.swaps || []).length} swaps · ${SEASON_SCHEDULE.length} scheduled weeks`
  );

  const totals = {};
  for (const m of managers) totals[m.name] = { batting: 0, pitching: 0 };

  const t0 = performance.now();
  SEASON_SCHEDULE.forEach((schedWeek, idx) => {
    for (const m of managers) {
      totals[m.name].batting += app.managerWeekSubtotal(sd, m.name, schedWeek, idx, batting, 'batter', 'batters');
      totals[m.name].pitching += app.managerWeekSubtotal(sd, m.name, schedWeek, idx, pitching, 'pitcher', 'pitchers');
    }
  });
  const msPass = performance.now() - t0;

  for (const k of Object.keys(totals)) {
    totals[k].batting = Math.round(totals[k].batting * 100) / 100;
    totals[k].pitching = Math.round(totals[k].pitching * 100) / 100;
    totals[k].total = Math.round((totals[k].batting + totals[k].pitching) * 100) / 100;
  }

  const t1 = performance.now();
  const seeding = app.computePoolPlaySeeding(sd);
  const msSeeding = performance.now() - t1;

  console.log(`scoring pass:           ${msPass.toFixed(0)} ms  (${calls} managerWeekSubtotal calls)`);
  console.log(`computePoolPlaySeeding: ${msSeeding.toFixed(0)} ms`);
  console.log('\nper-manager totals');
  for (const [name, t] of Object.entries(totals).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${name.padEnd(24)} bat ${String(t.batting).padStart(10)}  pit ${String(t.pitching).padStart(10)}  total ${String(t.total).padStart(10)}`
    );
  }
  if (seeding) console.log(`\nseeded qualifiers: ${seeding.qualifierNames.join(', ')}`);

  if (args.json) {
    fs.writeFileSync(
      args.json,
      JSON.stringify({ source, totals, qualifiers: seeding ? seeding.qualifierNames : null }, null, 2)
    );
    console.log(`\ntotals written to ${args.json} (diff this against the other side of your change)`);
  }
})();
