#!/usr/bin/env node
/**
 * Season storage report — read-only.
 *
 * Answers "what is db.json actually made of, and what would an offseason archive save?"
 * with measurements instead of estimates. It opens the database, walks every season, and
 * classifies each stat row as ROSTERED (some manager held that player on that date, inside
 * the period the row belongs to) or FREE AGENT (nobody did). It then prices three
 * compaction tiers against the real bytes.
 *
 * It NEVER writes. Point it at a production copy and read the numbers.
 *
 * Usage:
 *   node scripts/season-storage-report.js [path/to/db.json] [--year 2026] [--json]
 *
 * Default input: $DB_PATH, else ./db.json.
 *
 * Roster membership comes from `roster_dates` + `schedule_dates` — the scoring invariant's own
 * sources — never from the sticky `manager` field on a stat row, which is a derived cache and
 * is exactly the field that was wrong for twelve days in the 2026 semifinal.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/season-storage-report.js [db.json] [--year YYYY] [--json]');
  process.exit(0);
}
const asJson = args.includes('--json');
const yearArg = (() => {
  const i = args.indexOf('--year');
  return i !== -1 ? args[i + 1] : null;
})();
const inputPath =
  args.find((a) => !a.startsWith('--') && a !== yearArg) ||
  process.env.DB_PATH ||
  path.join(__dirname, '..', 'db.json');

if (!fs.existsSync(inputPath)) {
  console.error(`Not found: ${inputPath}`);
  console.error('Pass a path, or set DB_PATH. Run this where a real db.json lives (the Render disk).');
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, 'utf8');
let db;
try {
  db = JSON.parse(raw);
} catch (e) {
  console.error(`Could not parse ${inputPath}: ${e.message}`);
  process.exit(1);
}

const bytes = (v) => (v === undefined ? 0 : JSON.stringify(v).length);
const mb = (n) => (n / 1048576).toFixed(2);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');

// ---- Roster membership, derived from roster_dates + the schedule -------------------------

// Every (player -> set of ISO dates) any manager held, derived from roster_dates windows clipped
// to the season's own calendar. A window with no add_date starts at the season start; one with no
// drop_date runs to the season end.
function rosteredDatesByPlayer(sd) {
  const dates = sd.schedule_dates || [];
  const seasonStart = dates.length && dates[0] ? dates[0].start : null;
  const seasonEnd = dates.length && dates[dates.length - 1] ? dates[dates.length - 1].end : null;
  const byPlayer = new Map(); // name -> [ [start,end], ... ]
  for (const weeks of Object.values(sd.roster_dates || {})) {
    for (const [weekKey, players] of Object.entries(weeks || {})) {
      void weekKey;
      for (const [player, d] of Object.entries(players || {})) {
        if (!d) continue;
        const start = d.add_date || seasonStart;
        const end = d.drop_date || seasonEnd;
        if (!start || !end || start > end) continue;
        if (!byPlayer.has(player)) byPlayer.set(player, []);
        byPlayer.get(player).push([start, end]);
      }
    }
  }
  // Players sitting in a week's roster array with no date event at all (an initial submission
  // that predates roster_dates) are not represented here; they show up as free agents, which
  // makes this report a LOWER bound on what an archive keeps. The archive endpoint itself must
  // use the roster arrays as the same fallback managerWeekRosterWindows does.
  return byPlayer;
}

function wasRosteredOn(byPlayer, player, date) {
  const spans = byPlayer.get(player);
  if (!spans) return false;
  for (const [s, e] of spans) if (date >= s && date <= e) return true;
  return false;
}

function wasRosteredDuring(byPlayer, player, start, end) {
  const spans = byPlayer.get(player);
  if (!spans || !start || !end) return false;
  for (const [s, e] of spans) if (s <= end && e >= start) return true;
  return false;
}

// ---- Report -----------------------------------------------------------------------------

const report = { file: inputPath, file_bytes: raw.length, seasons: {} };

const years = Object.keys(db.seasons || {}).filter((y) => !yearArg || y === String(yearArg));
if (years.length === 0) {
  console.error(yearArg ? `No season ${yearArg} in ${inputPath}` : `No seasons in ${inputPath}`);
  process.exit(1);
}

for (const year of years.sort()) {
  const sd = db.seasons[year];
  if (!sd || typeof sd !== 'object') continue;

  const fields = Object.keys(sd)
    .map((k) => ({ key: k, bytes: bytes(sd[k]), count: Array.isArray(sd[k]) ? sd[k].length : null }))
    .sort((a, b) => b.bytes - a.bytes);

  const byPlayer = rosteredDatesByPlayer(sd);

  // Week calendar spans, so a weekly row can be classified without a schedule copy: match the
  // row's (round, week) to the schedule_dates entry at the same index as the season stored it.
  // schedule_dates is positional, so build the map from whichever weekly rows carry each label
  // together with the daily rows' own dates.
  const weekSpan = new Map(); // "round|week" -> { start, end }
  for (const r of sd.daily_batting || []) {
    const k = `${r.round}|${r.week}`;
    const cur = weekSpan.get(k) || { start: r.date, end: r.date };
    if (r.date < cur.start) cur.start = r.date;
    if (r.date > cur.end) cur.end = r.date;
    weekSpan.set(k, cur);
  }
  for (const r of sd.daily_pitching || []) {
    const k = `${r.round}|${r.week}`;
    const cur = weekSpan.get(k) || { start: r.date, end: r.date };
    if (r.date < cur.start) cur.start = r.date;
    if (r.date > cur.end) cur.end = r.date;
    weekSpan.set(k, cur);
  }

  const split = (rows, nameKey, isDaily) => {
    let keepN = 0,
      keepB = 0,
      dropN = 0,
      dropB = 0,
      cumB = 0,
      zeroB = 0;
    for (const r of rows || []) {
      const b = bytes(r);
      const name = r[nameKey];
      let keep;
      if (isDaily) {
        keep = wasRosteredOn(byPlayer, name, r.date);
      } else {
        const span = weekSpan.get(`${r.round}|${r.week}`);
        keep = span ? wasRosteredDuring(byPlayer, name, span.start, span.end) : !!r.manager;
      }
      if (keep) {
        keepN++;
        keepB += b;
        if (isDaily && r.cumulative && r.delta && JSON.stringify(r.cumulative) === JSON.stringify(r.delta)) {
          cumB += bytes(r.cumulative) + nameKey.length; // the duplicated half plus its key
        }
        if (isDaily && r.delta) {
          const sparse = Object.fromEntries(Object.entries(r.delta).filter(([, v]) => v));
          zeroB += bytes(r.delta) - bytes(sparse);
        }
      } else {
        dropN++;
        dropB += b;
      }
    }
    return { keepN, keepB, dropN, dropB, cumB, zeroB };
  };

  const dBat = split(sd.daily_batting, 'batter', true);
  const dPit = split(sd.daily_pitching, 'pitcher', true);
  const wBat = split(sd.weekly_batting, 'batter', false);
  const wPit = split(sd.weekly_pitching, 'pitcher', false);

  const total = bytes(sd);
  // Fields an archived (closed, frozen) season does not need: derived caches, live-season
  // scratch, and the whole-of-MLB pools/maps that only the swap form's autocomplete wants.
  const DISPOSABLE = ['score_snapshots', 'playoff_odds', 'bracket_odds', 'hot_takes', 'upload_log'];
  const SHRINKABLE = ['batters_pool', 'pitchers_pool', 'batters_team', 'pitchers_team', 'mlb_ids'];
  const disposableB = DISPOSABLE.reduce((s, k) => s + bytes(sd[k]), 0);
  const shrinkableB = SHRINKABLE.reduce((s, k) => s + bytes(sd[k]), 0);

  const tier1 = total - dBat.dropB - dPit.dropB; // dailies: rostered player-days only
  const tier2 = tier1 - wBat.dropB - wPit.dropB; // + weeklies: rostered players only
  const tier3 = tier2 - disposableB - Math.round(shrinkableB * 0.9); // + derived caches and pools
  const tier4 = tier3 - dBat.cumB - dPit.cumB - dBat.zeroB - dPit.zeroB; // + per-row field trim

  const s = {
    total_bytes: total,
    fields,
    daily_batting: dBat,
    daily_pitching: dPit,
    weekly_batting: wBat,
    weekly_pitching: wPit,
    disposable_bytes: disposableB,
    shrinkable_bytes: shrinkableB,
    tiers: { current: total, tier1, tier2, tier3, tier4 },
  };
  report.seasons[year] = s;

  if (asJson) continue;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`SEASON ${year} — ${mb(total)} MB`);
  console.log('='.repeat(72));
  console.log('\nLargest fields:');
  for (const f of fields.slice(0, 12)) {
    const n = f.count === null ? '' : ` (${f.count.toLocaleString()} rows)`;
    console.log(`  ${mb(f.bytes).padStart(8)} MB  ${pct(f.bytes, total).padStart(5)}%  ${f.key}${n}`);
  }

  console.log('\nStat rows, by whether anyone rostered the player:');
  const line = (label, r) =>
    console.log(
      `  ${label.padEnd(16)} rostered ${String(r.keepN).padStart(7)} rows / ${mb(r.keepB).padStart(7)} MB` +
        `   free agent ${String(r.dropN).padStart(7)} rows / ${mb(r.dropB).padStart(7)} MB` +
        `   (${pct(r.dropB, r.keepB + r.dropB)}% droppable)`
    );
  line('daily_batting', dBat);
  line('daily_pitching', dPit);
  line('weekly_batting', wBat);
  line('weekly_pitching', wPit);

  if (byPlayer.size === 0) {
    console.log('\n  ! roster_dates is empty for this season, so nothing could be classified as rostered.');
    console.log('    The numbers above are not meaningful here — run against a season that was played.');
  }

  console.log('\nArchive tiers (each includes the ones above it):');
  const tier = (n, label, v) =>
    console.log(`  ${n}. ${label.padEnd(46)} ${mb(v).padStart(7)} MB   (${pct(v, total)}% of today)`);
  tier(0, 'today', total);
  tier(1, 'dailies: rostered player-days only', tier1);
  tier(2, '+ weeklies: rostered players only', tier2);
  tier(3, '+ drop derived caches, shrink pools/maps', tier3);
  tier(4, '+ drop duplicate `cumulative` and zero stats', tier4);
  console.log(`\n  Upstash backup limit is ~1.00 MB. Tier 4 ${tier4 <= 1048576 ? 'FITS' : 'does NOT fit'}.`);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nWhole file: ${mb(raw.length)} MB at ${inputPath}`);
  console.log('Nothing was written.\n');
}
