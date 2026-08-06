// ============================================================
// WMMC — League history (pure)
// ============================================================
// The league's finished seasons, and the per-manager career facts derived from them.
//
// `WMMC_HISTORICAL_RESULTS` is the authoritative record of every season played before the
// app existed (2018-2025) — add a new entry each year after the Finals are finalized. It
// lived in app.js until the Slack playoff commentary needed the same table server-side;
// this module is now the canonical copy, app.js reads it off `window` (via js/index.js),
// and server.js keeps a synced duplicate because it cannot import an ES module. Edit all
// the copies together, exactly like SCORING / SEASON_SCHEDULE.
//
// Nothing here reads a roster, a stat row or a date window: a finished season's result is a
// settled fact, and re-deriving it from stats would only create a second answer to a
// question that already has one.

export const WMMC_HISTORICAL_RESULTS = [
  {
    year: '2018',
    champion: 'Cam McCallum',
    runnerUp: 'Alex Thalacker',
    third: 'Dan Kortan',
    standings: {
      'Cam McCallum': 1,
      'Alex Thalacker': 2,
      'Dan Kortan': 3,
      'Ryan Sullivan': 4,
      'Chris Bentivegna': 5,
      'Anton Capria': 6,
      'Jamie Rogers': 7,
      'Ryan Courville': 8,
      'Stephen Farmer': 9,
      'Marcus Gillespie': 10,
      'Austin Johnson': 11,
    },
  },
  {
    year: '2019',
    champion: 'Joey Auclair',
    runnerUp: 'Cam McCallum',
    third: 'Alex Thalacker',
    standings: {
      'Joey Auclair': 1,
      'Cam McCallum': 2,
      'Alex Thalacker': 3,
      'Chris Bentivegna': 4,
      'Dan Kortan': 5,
      'Ryan Sullivan': 6,
      'Jamie Rogers': 7,
      'Anton Capria': 8,
      'Austin Johnson': 9,
      'Stephen Farmer': 10,
      'Ryan Courville': 11,
      'Marcus Gillespie': 12,
    },
  },
  {
    year: '2020',
    champion: 'Ryan Sullivan',
    runnerUp: 'Dan Kortan',
    third: 'Marcus Gillespie',
    standings: {
      'Ryan Sullivan': 1,
      'Dan Kortan': 2,
      'Marcus Gillespie': 3,
      'Cam McCallum': 4,
      'Ryan Courville': 5,
      'Joey Auclair': 6,
      'Austin Johnson': 7,
      'Edgar Rivas': 8,
      'Anton Capria': 9,
      'Jamie Rogers': 10,
      'Alex Thalacker': 11,
      'Chris Bentivegna': 12,
    },
  },
  {
    year: '2021',
    champion: 'Ryan Sullivan',
    runnerUp: 'Dan Kortan',
    third: 'Joey Auclair',
    standings: {
      'Ryan Sullivan': 1,
      'Dan Kortan': 2,
      'Joey Auclair': 3,
      'Austin Johnson': 4,
      'Chris Bentivegna': 5,
      'Ryan Courville': 6,
      'Anton Capria': 7,
      'Marcus Gillespie': 8,
      'Cam McCallum': 9,
      'Jamie Rogers': 10,
      'Edgar Rivas': 11,
      'Alex Thalacker': 12,
    },
  },
  {
    year: '2022',
    champion: 'Dan Kortan',
    runnerUp: 'Alex Thalacker',
    third: 'Ryan Sullivan',
    standings: {
      'Dan Kortan': 1,
      'Alex Thalacker': 2,
      'Ryan Sullivan': 3,
      'Austin Johnson': 4,
      'Joey Auclair': 5,
      'Chris Bentivegna': 6,
      'Jamie Rogers': 7,
      'Cam McCallum': 8,
      'Edgar Rivas': 9,
      'Anton Capria': 10,
      'Marcus Gillespie': 11,
      'Ryan Courville': 12,
    },
  },
  {
    year: '2023',
    champion: 'Austin Johnson',
    runnerUp: 'Dan Kortan',
    third: 'Anton Capria',
    standings: {
      'Austin Johnson': 1,
      'Dan Kortan': 2,
      'Anton Capria': 3,
      'Cam McCallum': 4,
      'Ryan Sullivan': 5,
      'Marcus Gillespie': 6,
      'Alex Thalacker': 7,
      'Jamie Rogers': 8,
      'Joey Auclair': 9,
      'Ryan Courville': 10,
      'Chris Bentivegna': 11,
      'Edgar Rivas': 12,
    },
  },
  {
    year: '2024',
    champion: 'Dan Kortan',
    runnerUp: 'Ryan Courville',
    third: 'Jamie Rogers',
    standings: {
      'Dan Kortan': 1,
      'Ryan Courville': 2,
      'Jamie Rogers': 3,
      'Austin Johnson': 4,
      'Marcus Gillespie': 5,
      'Anton Capria': 6,
      'Cam McCallum': 7,
      'Chris Bentivegna': 8,
      'Joey Auclair': 9,
      'Ryan Sullivan': 10,
      'Alex Thalacker': 11,
      'Edgar Rivas': 12,
    },
  },
  {
    year: '2025',
    champion: 'Joey Auclair',
    runnerUp: 'Anton Capria',
    third: 'Ryan Sullivan',
    standings: {
      'Joey Auclair': 1,
      'Anton Capria': 2,
      'Ryan Sullivan': 3,
      'Cam McCallum': 4,
      'Marcus Gillespie': 5,
      'Dan Kortan': 6,
      'Jamie Rogers': 7,
      'Austin Johnson': 8,
      'Ryan Courville': 9,
      'Chris Bentivegna': 10,
      'Edgar Rivas': 11,
      'Alex Thalacker': 12,
    },
  },
];

// Names in the historical tables above are whatever the league called someone at the time;
// `db.managers` holds what the commissioner page calls them now. Map the old spelling to the
// current one so a manager's career doesn't split in two halfway through it. Keyed old -> new.
export const HISTORICAL_NAME_ALIASES = {
  'Dan Kortan': 'Daniel Kortan',
};

// Canonical (current) form of a name that may appear in either spelling.
export function canonicalManagerName(name) {
  if (!name) return '';
  return HISTORICAL_NAME_ALIASES[name] || name;
}

// The bracket stage a FINAL finishing position corresponds to. Mirrors
// statusKeyForPosition in js/playoffStatus.js — the ladder is 1st/2nd = the Finals,
// 3rd/4th = lost the semifinal (the 3rd-place game settles which), 5th-8th = lost the
// quarterfinal, anything past the field size = never made the bracket.
export function exitStageForPlace(place, fieldSize = 8) {
  if (!place || place < 1) return null;
  if (place <= 2) return 'Finals';
  if (place <= 4) return 'SF';
  if (place <= fieldSize) return 'QF';
  return 'DNQ';
}

// One manager's career as the finished seasons record it, newest season last.
//
//   results     — WMMC_HISTORICAL_RESULTS (or a subset/fixture with the same shape)
//   throughYear — ignore seasons at or after this year (pass the season in progress, so an
//                 in-flight year can never be counted as history)
//
// Returns null when the manager has no recorded finish at all (a first-year manager).
// Every count is over seasons the manager actually played — a year they sat out simply
// isn't in `seasons`.
export function managerPlayoffHistory(name, results = WMMC_HISTORICAL_RESULTS, { throughYear = null } = {}) {
  const canon = canonicalManagerName(name);
  if (!canon) return null;

  const seasons = [];
  for (const row of results || []) {
    const year = Number(row && row.year);
    if (!year) continue;
    if (throughYear != null && year >= Number(throughYear)) continue;
    const standings = row.standings || {};
    let place = null;
    for (const [who, pos] of Object.entries(standings)) {
      if (canonicalManagerName(who) === canon) {
        place = pos;
        break;
      }
    }
    if (!place) continue;
    seasons.push({ year, place, stage: exitStageForPlace(place, 8) });
  }
  if (seasons.length === 0) return null;
  seasons.sort((a, b) => a.year - b.year);

  const stageIn = (stage) => seasons.filter((s) => s.stage === stage);
  const titles = seasons.filter((s) => s.place === 1).map((s) => s.year);
  const runnerUps = seasons.filter((s) => s.place === 2).map((s) => s.year);
  const madePlayoffs = seasons.filter((s) => s.stage !== 'DNQ');
  const latest = seasons[seasons.length - 1];

  // Consecutive most-recent seasons that ended at the same stage — the "always loses in the
  // quarterfinals" fact, and the reason it is worth saying out loud only when it is a streak
  // rather than a scattered handful.
  let currentStageStreak = 0;
  for (let i = seasons.length - 1; i >= 0; i--) {
    if (seasons[i].stage !== latest.stage) break;
    currentStageStreak++;
  }

  // How long since they last got past each stage — null when they never have.
  const lastYearReaching = (stages) => {
    const hit = seasons.filter((s) => stages.includes(s.stage));
    return hit.length ? hit[hit.length - 1].year : null;
  };

  return {
    manager: canon,
    seasons,
    seasonsPlayed: seasons.length,
    titles,
    titleCount: titles.length,
    lastTitle: titles.length ? titles[titles.length - 1] : null,
    runnerUps,
    playoffAppearances: madePlayoffs.length,
    dnqCount: stageIn('DNQ').length,
    qfExitCount: stageIn('QF').length,
    sfExitCount: stageIn('SF').length,
    finalsAppearances: stageIn('Finals').length,
    lastStage: latest.stage,
    lastPlace: latest.place,
    lastYear: latest.year,
    currentStageStreak,
    lastYearInFinals: lastYearReaching(['Finals']),
    lastYearInSemis: lastYearReaching(['Finals', 'SF']),
    neverPastQF: madePlayoffs.length > 0 && stageIn('SF').length === 0 && stageIn('Finals').length === 0,
    neverMadeFinals: madePlayoffs.length > 0 && stageIn('Finals').length === 0,
  };
}
