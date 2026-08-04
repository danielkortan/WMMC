// ============================================================
// WMMC — Hypothetical ("What If") scoring engine
// ============================================================
// Answers "what would the standings look like if…" WITHOUT touching league data. Every function
// here is pure: it reads a frozen snapshot and a scenario, and returns numbers. Nothing in this
// module writes, fetches, or mutates — the sandbox has no path to db.json by construction.
//
// THE FIDELITY RULE, and why the engine is built the way it is.
//
// A slot's hypothetical score is NOT recomputed from scratch. It is:
//
//     hypothetical = realScore + ( score(rows, scenarioTable) - score(rows, realTable) )
//
// The real score is taken as authoritative and only the DELTA is derived. This matters because a
// stored weekly_score is not always reproducible from raw stat lines: commissioner-entered rows
// (`manual_fields` / `drop_locked`) carry hand-set numbers, and a weekly row's counting stats are
// the UNCLIPPED week total while its weekly_score is clipped to the player's roster window (see
// rebuildWeeklyFromDaily / computeEffectiveBattingScore in server.js). Deriving only the delta
// makes whatever the engine cannot reproduce cancel out of the subtraction.
//
// The consequence worth stating plainly: under the empty scenario every delta is exactly zero, so
// the sandbox reproduces the live scoreboard by construction rather than by coincidence. A "what
// if" can therefore never quietly disagree with reality about what actually happened.
//
// SLOTS ARE SUPPLIED, NOT DERIVED. The caller passes the resolved roster slots — the output of the
// real eligibility path (managerWeekSubtotal in app.js), which owns the core scoring invariant.
// This module deliberately does NOT reimplement "who was rostered when": a second copy of that
// rule would be a second thing to keep in sync, and the invariant says there is one source of
// truth for roster windows. The engine re-scores the slots it is given.

import {
  SCORING,
  SEASON_SCHEDULE,
  calculateBattingScore,
  calculatePitchingScore,
  BATTING_STAT_KEYS,
  PITCHING_STAT_KEYS,
} from './scoring.js';
import { seedFromPeriodTotals } from './seeding.js';

// A scenario that changes nothing. Scoring the snapshot against this must return the real
// standings, unchanged — that is the property tests/hypothetical.test.js pins down.
export const EMPTY_SCENARIO = Object.freeze({ scoring: null, rosters: null });

// Stats that our stored rows carry but the league does not score. Surfacing them is the honest
// version of "change the counting stats": these are answerable from recorded data. A stat that
// was never recorded (HBP, GIDP…) cannot be added retroactively and must not be offered.
export const UNSCORED_BATTING_KEYS = Object.freeze(['ABS', 'SO', 'LOB']);
export const UNSCORED_PITCHING_KEYS = Object.freeze(['GS']);

const r2 = (x) => Math.round(x * 100) / 100;

// Merge a partial set of point-value overrides onto the real table. Returns a NEW table; the real
// SCORING object is never mutated (it is shared with the live scoreboard).
export function buildScoringTable(overrides) {
  const table = {
    batting: { ...SCORING.batting },
    pitching: { ...SCORING.pitching },
  };
  if (!overrides) return table;
  for (const side of ['batting', 'pitching']) {
    for (const [key, value] of Object.entries(overrides[side] || {})) {
      const num = Number(value);
      table[side][key] = Number.isFinite(num) ? num : 0;
    }
  }
  return table;
}

// Which point values a scenario actually changes, for the "10 → 12" badges. Compares against the
// real table, so a slider dragged back to its original value correctly reads as no change.
export function scoringDiff(overrides) {
  const table = buildScoringTable(overrides);
  const changes = [];
  for (const side of ['batting', 'pitching']) {
    const allKeys = new Set([...Object.keys(SCORING[side]), ...Object.keys(table[side])]);
    for (const key of allKeys) {
      const from = SCORING[side][key] || 0;
      const to = table[side][key] || 0;
      if (from !== to) changes.push({ side, key, from, to });
    }
  }
  return changes;
}

// Roster overrides, normalized to a flat list. A scenario stores them as
//   { [manager]: { [round]: { batters: [...], pitchers: [...] } } }
// where the lists REPLACE that manager's roster for the whole period. Period-level replacement
// (rather than per-week) is deliberate: it keeps every hypothetical roster window aligned to whole
// weeks, which is what makes the weekly stat rows an exact source rather than an approximation.
export function rosterOverrides(scenario) {
  const out = [];
  for (const [manager, byRound] of Object.entries((scenario && scenario.rosters) || {})) {
    for (const [round, lists] of Object.entries(byRound || {})) {
      if (!lists) continue;
      out.push({
        manager,
        round,
        batters: (lists.batters || []).slice(),
        pitchers: (lists.pitchers || []).slice(),
      });
    }
  }
  return out;
}

export function isEmptyScenario(scenario) {
  return scoringDiff(scenario && scenario.scoring).length === 0 && rosterOverrides(scenario).length === 0;
}

// Index daily rows by player+round+week so re-scoring touches only the rows for the slots being
// scored. Without this, every recompute is a full scan of every daily row (tens of thousands in a
// live season) per slot — the difference between an instant slider and a frozen tab.
function indexDaily(rows, playerKey) {
  const idx = new Map();
  for (const row of rows || []) {
    const key = `${row[playerKey]}\0${row.round}\0${row.week}`;
    const bucket = idx.get(key);
    if (bucket) bucket.push(row);
    else idx.set(key, [row]);
  }
  return idx;
}

function indexWeekly(rows, playerKey) {
  const idx = new Map();
  for (const row of rows || []) {
    idx.set(`${row[playerKey]}\0${row.round}\0${row.week}`, row);
  }
  return idx;
}

// A second index of the same rows, keyed by player alone. The Player Explorer asks a different
// question from the scorer — "everything this one player did, all season" rather than "this
// player, this week" — and answering it by scanning every row would make each keystroke a full
// table scan. Rows are shared with the other indexes, so this costs map entries, not stat data.
function indexByPlayer(rows, playerKey) {
  const idx = new Map();
  for (const row of rows || []) {
    const name = row[playerKey];
    if (!name) continue;
    const bucket = idx.get(name);
    if (bucket) bucket.push(row);
    else idx.set(name, [row]);
  }
  return idx;
}

// Build the immutable input the engine scores against.
//
// `slots` are the resolved roster slots from the real eligibility path:
//   { manager, round, week, weekIdx, player, type: 'batting'|'pitching', realScore,
//     addDate, dropDate }
// `addDate`/`dropDate` are THIS manager's window for that week (null when they held the player
// for the whole week) — they are what splits a mid-week handover correctly.
export function buildSnapshot({
  slots = [],
  dailyBatting = [],
  dailyPitching = [],
  weeklyBatting = [],
  weeklyPitching = [],
  scheduleDates = [],
  playerDates = {},
  managers = [],
  schedule = SEASON_SCHEDULE,
  pools = {},
} = {}) {
  return {
    slots: slots.slice(),
    managers: managers.slice(),
    schedule,
    pools: pools || {},
    scheduleDates,
    playerDates: playerDates || {},
    dailyIdx: {
      batting: indexDaily(dailyBatting, 'batter'),
      pitching: indexDaily(dailyPitching, 'pitcher'),
    },
    weeklyIdx: {
      batting: indexWeekly(weeklyBatting, 'batter'),
      pitching: indexWeekly(weeklyPitching, 'pitcher'),
    },
    dailyByPlayer: {
      batting: indexByPlayer(dailyBatting, 'batter'),
      pitching: indexByPlayer(dailyPitching, 'pitcher'),
    },
    weeklyByPlayer: {
      batting: indexByPlayer(weeklyBatting, 'batter'),
      pitching: indexByPlayer(weeklyPitching, 'pitcher'),
    },
    hasDaily: (dailyBatting || []).length > 0 || (dailyPitching || []).length > 0,
  };
}

// The date window a slot's stats are counted in. Mirrors computeEffectiveBattingScore in
// server.js: a player_dates override REPLACES the corresponding calendar bound (both inclusive),
// and the manager's own add/drop then narrows it further so a contested week splits correctly.
function slotWindow(snapshot, slot) {
  const weekDates = (snapshot.scheduleDates || [])[slot.weekIdx] || null;
  const pdType = slot.type === 'batting' ? 'batter' : 'pitcher';
  const override =
    (((snapshot.playerDates || {})[`${slot.round}|${slot.week}`] || {})[pdType] || {})[slot.player] || {};

  let start = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
  let end = 'end' in override ? override.end : (weekDates && weekDates.end) || null;
  if (slot.addDate && (!start || slot.addDate > start)) start = slot.addDate;
  if (slot.dropDate && (!end || slot.dropDate < end)) end = slot.dropDate;
  return { start, end };
}

// Points a slot's stat rows are worth under `table`, plus how that number was reached.
// `exact` is true only when per-game daily rows were available — those reproduce the real scoring
// path date for date. The weekly fallback uses the week's UNCLIPPED totals, so for a player added
// or dropped mid-week it counts days the manager did not own; the delta is then an estimate, and
// says so rather than quietly presenting an approximation as fact.
function scoreSlot(snapshot, slot, table) {
  const key = `${slot.player}\0${slot.round}\0${slot.week}`;
  const calc = slot.type === 'batting' ? calculateBattingScore : calculatePitchingScore;
  const daily = snapshot.dailyIdx[slot.type].get(key);

  if (daily && daily.length) {
    const { start, end } = slotWindow(snapshot, slot);
    let sum = 0;
    for (const row of daily) {
      if (start && row.date < start) continue;
      if (end && row.date > end) continue;
      sum += calc(row.delta || row.cumulative || {}, table);
    }
    return { score: r2(sum), exact: true };
  }

  const weekly = snapshot.weeklyIdx[slot.type].get(key);
  if (weekly) {
    const clipped = !!(slot.addDate || slot.dropDate);
    return { score: calc(weekly, table), exact: !clipped };
  }

  // No stat rows at all — an empty roster slot. Contributes nothing under any scoring table, so
  // its delta is exactly zero either way.
  return { score: 0, exact: true };
}

// The weeks belonging to a round, in schedule order.
export function weeksInRound(snapshot, round) {
  const schedule = snapshot.schedule || SEASON_SCHEDULE;
  const out = [];
  schedule.forEach((s, idx) => {
    if (s.round === round) out.push({ week: s.week, weekIdx: idx });
  });
  return out;
}

// Which rounds a manager actually played, from their real slots. A round absent here is one they
// never reached — the case the Roster Lab lets them fill in by hand.
export function roundsPlayed(snapshot, manager) {
  const rounds = new Set();
  for (const slot of snapshot.slots) {
    if (slot.manager === manager) rounds.add(slot.round);
  }
  return rounds;
}

// The roster a manager really had for a period, as { batters, pitchers } — the Roster Lab's
// starting point, and what an override is diffed against.
export function realRosterForRound(snapshot, manager, round) {
  const batters = new Set();
  const pitchers = new Set();
  for (const slot of snapshot.slots) {
    if (slot.manager !== manager || slot.round !== round) continue;
    (slot.type === 'batting' ? batters : pitchers).add(slot.player);
  }
  return { batters: [...batters], pitchers: [...pitchers] };
}

// Resolve the scenario's roster overrides into the slot set that should actually be scored.
//
// A (manager, round) with an override has its real slots REPLACED: each named player gets a slot
// for every week of that period. Where the player really was on that roster that week, the real
// slot is reused so its authoritative score still anchors the arithmetic; where they were not, a
// SYNTHETIC slot is created and scored from stat rows alone.
//
// Synthetic slots are also how a counterfactual round works. A manager knocked out in the QF has
// no SF slots at all, so every player they enter for the SF is synthetic — real 0, hypothetical
// scored from what those players actually did that fortnight. That is a real answer to "what
// would I have scored", and it is never mistaken for a claim about what happened.
function resolveSlots(snapshot, scenario) {
  const overrides = rosterOverrides(scenario);
  if (overrides.length === 0) return { slots: snapshot.slots, benched: [], added: [] };

  const overridden = new Set(overrides.map((o) => `${o.manager}\0${o.round}`));
  const realByKey = new Map();
  for (const slot of snapshot.slots) {
    realByKey.set(`${slot.manager}\0${slot.round}\0${slot.week}\0${slot.type}\0${slot.player}`, slot);
  }

  const slots = snapshot.slots.filter((s) => !overridden.has(`${s.manager}\0${s.round}`));
  const benched = [];
  const added = [];

  for (const o of overrides) {
    const weeks = weeksInRound(snapshot, o.round);
    const kept = new Set();
    for (const [type, players] of [
      ['batting', o.batters],
      ['pitching', o.pitchers],
    ]) {
      for (const player of players) {
        let everReal = false;
        for (const { week, weekIdx } of weeks) {
          const key = `${o.manager}\0${o.round}\0${week}\0${type}\0${player}`;
          kept.add(key);
          const real = realByKey.get(key);
          if (real) {
            everReal = true;
            slots.push(real);
          } else {
            slots.push({
              manager: o.manager,
              round: o.round,
              week,
              weekIdx,
              player,
              type,
              realScore: 0,
              addDate: null,
              dropDate: null,
              synthetic: true,
            });
          }
        }
        if (!everReal) added.push({ manager: o.manager, round: o.round, player, type });
      }
    }
    // Players the manager really had this period but left out of the override are benched: their
    // real points still stand in the Real column, and they score nothing in the hypothetical.
    for (const slot of snapshot.slots) {
      if (slot.manager !== o.manager || slot.round !== o.round) continue;
      const key = `${slot.manager}\0${slot.round}\0${slot.week}\0${slot.type}\0${slot.player}`;
      if (!kept.has(key)) benched.push(slot);
    }
  }

  return { slots, benched, added };
}

// Score a scenario. Returns real / hypothetical / delta totals per manager, per period and per
// player, the playoff picture under the scenario, and a fidelity report the UI must disclose.
//
// The REAL column always sums the real slots, whatever the scenario does to the rosters — it is
// what actually happened and no override can move it. The HYPOTHETICAL column sums the resolved
// slot set. With no roster override the two run over the same slots and the delta-only derivation
// holds exactly (see the header note); a roster override is the one case where a hypothetical
// figure is built from raw stat rows rather than anchored to a stored score.
export function scoreScenario(snapshot, scenario = EMPTY_SCENARIO) {
  const table = buildScoringTable(scenario && scenario.scoring);
  const identity = isEmptyScenario(scenario);
  const { slots: effectiveSlots, benched, added } = resolveSlots(snapshot, scenario);

  const byManager = new Map();
  const byPlayer = new Map();
  const byPlayerRound = new Map();
  let approximateSlots = 0;
  let scoredSlots = 0;
  let syntheticSlots = 0;

  const managerEntry = (name) => {
    let e = byManager.get(name);
    if (!e) {
      e = { manager: name, real: 0, hypothetical: 0, periods: new Map(), approximate: 0 };
      byManager.set(name, e);
    }
    return e;
  };

  const periodEntry = (entry, round) => {
    let p = entry.periods.get(round);
    if (!p) {
      p = { round, real: 0, hypothetical: 0, delta: 0, realBat: 0, realPit: 0, hypoBat: 0, hypoPit: 0 };
      entry.periods.set(round, p);
    }
    return p;
  };

  const playerEntry = (manager, player, type) => {
    const key = `${manager}\0${player}\0${type}`;
    let p = byPlayer.get(key);
    if (!p) {
      p = { manager, player, type, real: 0, hypothetical: 0, delta: 0, exact: true, benched: false, added: false };
      byPlayer.set(key, p);
    }
    return p;
  };

  // The same per-player figures, scoped to ONE period. This is what the Roster Lab's side-by-side
  // view reads: for a given manager and round it needs "what this player really scored for me"
  // next to "what they'd score under the scenario", which a season-wide total cannot answer.
  const playerRoundEntry = (manager, round, player, type) => {
    const key = `${manager}\0${round}\0${player}\0${type}`;
    let p = byPlayerRound.get(key);
    if (!p) {
      p = {
        manager,
        round,
        player,
        type,
        real: 0,
        hypothetical: 0,
        delta: 0,
        exact: true,
        benched: false,
        added: false,
      };
      byPlayerRound.set(key, p);
    }
    return p;
  };

  // Pass 1 — the Real column, over the real slots only. Untouched by any override.
  for (const slot of snapshot.slots) {
    const real = Number(slot.realScore) || 0;
    const entry = managerEntry(slot.manager);
    entry.real = r2(entry.real + real);
    const period = periodEntry(entry, slot.round);
    period.real = r2(period.real + real);
    if (slot.type === 'batting') period.realBat = r2(period.realBat + real);
    else period.realPit = r2(period.realPit + real);
    const player = playerEntry(slot.manager, slot.player, slot.type);
    player.real = r2(player.real + real);
    const pr = playerRoundEntry(slot.manager, slot.round, slot.player, slot.type);
    pr.real = r2(pr.real + real);
  }

  // Pass 2 — the What If column, over the resolved slots.
  for (const slot of effectiveSlots) {
    const real = Number(slot.realScore) || 0;
    let hypothetical = real;
    let exact = true;

    if (slot.synthetic) {
      // No authoritative score to anchor to — this player was not on this roster. Score them
      // straight from their stat rows for the week.
      const scored = scoreSlot(snapshot, slot, table);
      hypothetical = scored.score;
      exact = scored.exact;
      syntheticSlots++;
      scoredSlots++;
      if (!exact) approximateSlots++;
    } else if (!identity) {
      const scenarioSide = scoreSlot(snapshot, slot, table);
      const realSide = scoreSlot(snapshot, slot, SCORING);
      hypothetical = r2(real + r2(scenarioSide.score - realSide.score));
      exact = scenarioSide.exact && realSide.exact;
      scoredSlots++;
      if (!exact) approximateSlots++;
    }

    const entry = managerEntry(slot.manager);
    entry.hypothetical = r2(entry.hypothetical + hypothetical);
    if (!exact) entry.approximate++;
    const period = periodEntry(entry, slot.round);
    period.hypothetical = r2(period.hypothetical + hypothetical);
    if (slot.type === 'batting') period.hypoBat = r2(period.hypoBat + hypothetical);
    else period.hypoPit = r2(period.hypoPit + hypothetical);
    const player = playerEntry(slot.manager, slot.player, slot.type);
    player.hypothetical = r2(player.hypothetical + hypothetical);
    if (slot.synthetic) player.added = true;
    if (!exact) player.exact = false;
    const pr = playerRoundEntry(slot.manager, slot.round, slot.player, slot.type);
    pr.hypothetical = r2(pr.hypothetical + hypothetical);
    if (slot.synthetic) pr.added = true;
    if (!exact) pr.exact = false;
  }

  // Managers with no slots at all still belong in the standings — an empty roster is a real
  // (zero) result, not a missing row. The manager list comes from the caller, which reads it from
  // db.managers; the engine never invents a manager from stat rows.
  for (const name of snapshot.managers) managerEntry(name);

  for (const b of benched) {
    playerEntry(b.manager, b.player, b.type).benched = true;
    playerRoundEntry(b.manager, b.round, b.player, b.type).benched = true;
  }

  for (const entry of byManager.values()) {
    for (const p of entry.periods.values()) p.delta = r2(p.hypothetical - p.real);
  }
  for (const p of byPlayer.values()) p.delta = r2(p.hypothetical - p.real);
  for (const p of byPlayerRound.values()) p.delta = r2(p.hypothetical - p.real);

  const standings = [...byManager.values()]
    .map((e) => ({
      manager: e.manager,
      real: e.real,
      hypothetical: e.hypothetical,
      delta: r2(e.hypothetical - e.real),
      approximate: e.approximate,
      periods: [...e.periods.values()],
    }))
    .sort((a, b) => b.hypothetical - a.hypothetical || a.manager.localeCompare(b.manager));

  const realOrder = [...standings].sort((a, b) => b.real - a.real || a.manager.localeCompare(b.manager));
  const realRank = new Map(realOrder.map((s, i) => [s.manager, i + 1]));
  standings.forEach((s, i) => {
    s.rank = i + 1;
    s.realRank = realRank.get(s.manager);
    s.rankDelta = s.realRank - s.rank;
  });

  return {
    identity,
    standings,
    players: [...byPlayer.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    playerRounds: [...byPlayerRound.values()],
    playoffs: playoffPicture(snapshot, standings),
    rosterChanges: { benched: benched.length, added: added.length, overrides: rosterOverrides(scenario) },
    fidelity: {
      exact: approximateSlots === 0,
      approximateSlots,
      scoredSlots,
      syntheticSlots,
      hasDaily: snapshot.hasDaily,
    },
  };
}

// Who would have made the playoffs. Runs the league's real seeding rule (js/seeding.js — the very
// function the live bracket uses) twice: once on the real pool-play totals, once on the scenario's,
// then reports who moves in and out.
//
// This answers the question the Roster Lab exists for — "would that change have gotten me in?" —
// without pretending to replay the tournament. Seeding is a pure function of pool-play scoring, so
// it is genuinely computable. What happens AFTER the seeds is not: a manager who never played the
// semifinal has no semifinal roster, which is why entering one is a deliberate, labeled step
// rather than something the engine invents.
function playoffPicture(snapshot, standings) {
  const pools = snapshot.pools || {};
  const entriesFor = (pick) =>
    standings
      .filter((s) => pools[s.manager])
      .map((s) => {
        const pp1 = s.periods.find((p) => p.round === 'PP1');
        const pp2 = s.periods.find((p) => p.round === 'PP2');
        return {
          manager: s.manager,
          pool: pools[s.manager],
          pp1Bat: pp1 ? pick(pp1).bat : 0,
          pp1Pit: pp1 ? pick(pp1).pit : 0,
          pp2Bat: pp2 ? pick(pp2).bat : 0,
          pp2Pit: pp2 ? pick(pp2).pit : 0,
        };
      });

  const real = seedFromPeriodTotals(entriesFor((p) => ({ bat: p.realBat, pit: p.realPit })));
  const hypothetical = seedFromPeriodTotals(entriesFor((p) => ({ bat: p.hypoBat, pit: p.hypoPit })));
  if (!real || !hypothetical) return null;

  const realSet = new Set(real.qualifierNames);
  const hypoSet = new Set(hypothetical.qualifierNames);
  return {
    real: real.qualifierNames,
    hypothetical: hypothetical.qualifierNames,
    in: hypothetical.qualifierNames.filter((n) => !realSet.has(n)),
    out: real.qualifierNames.filter((n) => !hypoSet.has(n)),
    changed: real.qualifierNames.join('|') !== hypothetical.qualifierNames.join('|'),
  };
}

// ============================================================
// Player Explorer
// ============================================================
// "What did this guy actually do, and what would he be worth under my scoring?" — answerable for
// ANY player with recorded stats, not just rostered ones, because the nightly sync stores a row
// for every player who appeared in a final game. That makes "what if I'd started him" answerable
// without building a scenario at all.

// Every player name with a stat row, for the search box. Filtered by `query` (case-insensitive
// substring) and capped, so typing stays responsive against a full-league name list.
export function searchPlayers(snapshot, { type = 'batting', query = '', limit = 25 } = {}) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const names = [];
  for (const name of snapshot.weeklyByPlayer[type].keys()) {
    if (q && !name.toLowerCase().includes(q)) continue;
    names.push(name);
  }
  names.sort((a, b) => {
    // Prefix matches first — typing "sot" should surface Soto above someone with "sot" mid-name.
    if (q) {
      const ap = a.toLowerCase().startsWith(q);
      const bp = b.toLowerCase().startsWith(q);
      if (ap !== bp) return ap ? -1 : 1;
    }
    return a.localeCompare(b);
  });
  return names.slice(0, limit);
}

// Which type(s) a name has rows for, so the UI can resolve a search without asking the user
// whether they mean a batter or a pitcher. Two-way players legitimately return both.
export function playerTypes(snapshot, player) {
  const out = [];
  if (snapshot.weeklyByPlayer.batting.has(player)) out.push('batting');
  if (snapshot.weeklyByPlayer.pitching.has(player)) out.push('pitching');
  return out;
}

// Who rostered this player, and for which weeks. Read from the resolved slots, so it reflects the
// real date-windowed ownership rather than the sticky `manager` field on a stat row.
export function playerOwnership(snapshot, player, type) {
  const byManager = new Map();
  for (const slot of snapshot.slots) {
    if (slot.player !== player || slot.type !== type) continue;
    let e = byManager.get(slot.manager);
    if (!e) {
      e = { manager: slot.manager, rounds: new Set(), weeks: 0, real: 0 };
      byManager.set(slot.manager, e);
    }
    e.rounds.add(slot.round);
    e.weeks++;
    e.real = r2(e.real + (Number(slot.realScore) || 0));
  }
  return [...byManager.values()].map((e) => ({ ...e, rounds: [...e.rounds] })).sort((a, b) => b.real - a.real);
}

// Per-game log: one row per stored daily record, scored both ways. Only available once daily rows
// are loaded — weekly rows cannot be broken back down into games.
export function playerGameLog(snapshot, player, type, scenario = EMPTY_SCENARIO) {
  const table = buildScoringTable(scenario && scenario.scoring);
  const calc = type === 'batting' ? calculateBattingScore : calculatePitchingScore;
  const rows = snapshot.dailyByPlayer[type].get(player) || [];
  return rows
    .map((row) => {
      const stats = row.delta || row.cumulative || {};
      return {
        date: row.date,
        round: row.round,
        week: row.week,
        stats,
        real: calc(stats, SCORING),
        hypothetical: calc(stats, table),
      };
    })
    .map((r) => ({ ...r, delta: r2(r.hypothetical - r.real) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Per-round totals for one player, scored both ways, with what each roster slot actually credited.
//
// `real` is derived from the player's own stat rows, so for a player nobody rostered it still
// answers "what was he worth" — the whole point of being able to look up any player. `credited` is
// separate: the points a manager was actually given for him, which differs whenever he was held
// for only part of a week. Keeping them distinct is what stops the explorer from implying a
// free agent scored for somebody.
export function playerRoundTotals(snapshot, player, type, scenario = EMPTY_SCENARIO) {
  const table = buildScoringTable(scenario && scenario.scoring);
  const calc = type === 'batting' ? calculateBattingScore : calculatePitchingScore;
  const rows = snapshot.weeklyByPlayer[type].get(player) || [];

  const byRound = new Map();
  const entry = (round) => {
    let e = byRound.get(round);
    if (!e) {
      e = { round, real: 0, hypothetical: 0, delta: 0, credited: 0, weeks: 0 };
      byRound.set(round, e);
    }
    return e;
  };

  for (const row of rows) {
    const e = entry(row.round);
    // Anchor to the STORED weekly score and derive only the delta — the same rule the scorer uses,
    // and for the same reason: a commissioner-adjusted row's stored score is authoritative and does
    // not necessarily equal a recomputation of its raw line. Recomputing here would make the
    // explorer quietly disagree with the scoreboard about what a player was worth.
    const stored = Number(row.weekly_score) || 0;
    e.real = r2(e.real + stored);
    e.hypothetical = r2(e.hypothetical + stored + r2(calc(row, table) - calc(row, SCORING)));
    e.weeks++;
  }
  for (const slot of snapshot.slots) {
    if (slot.player !== player || slot.type !== type) continue;
    entry(slot.round).credited = r2(entry(slot.round).credited + (Number(slot.realScore) || 0));
  }

  const order = new Map((snapshot.schedule || SEASON_SCHEDULE).map((s, i) => [s.round, i]));
  return [...byRound.values()]
    .map((e) => ({ ...e, delta: r2(e.hypothetical - e.real) }))
    .sort((a, b) => (order.get(a.round) ?? 99) - (order.get(b.round) ?? 99));
}

// Everything the explorer shows for one player, in one call.
export function explainPlayer(snapshot, player, type, scenario = EMPTY_SCENARIO) {
  const rounds = playerRoundTotals(snapshot, player, type, scenario);
  const log = snapshot.hasDaily ? playerGameLog(snapshot, player, type, scenario) : [];
  const total = rounds.reduce(
    (acc, r) => ({
      real: r2(acc.real + r.real),
      hypothetical: r2(acc.hypothetical + r.hypothetical),
      credited: r2(acc.credited + r.credited),
    }),
    { real: 0, hypothetical: 0, credited: 0 }
  );
  return {
    player,
    type,
    rounds,
    log,
    owners: playerOwnership(snapshot, player, type),
    total: { ...total, delta: r2(total.hypothetical - total.real) },
    hasGameLog: log.length > 0,
  };
}

// Stat keys a scoring table can address, for building the lab's inputs. Split into the values the
// league really uses and the recorded-but-unscored extras, so the UI can present them separately.
export function scoringKeys() {
  return {
    batting: {
      scored: Object.keys(SCORING.batting),
      unscored: UNSCORED_BATTING_KEYS.filter((k) => Object.values(BATTING_STAT_KEYS).includes(k)),
    },
    pitching: {
      scored: Object.keys(SCORING.pitching),
      unscored: UNSCORED_PITCHING_KEYS.filter((k) => Object.values(PITCHING_STAT_KEYS).includes(k)),
    },
  };
}
