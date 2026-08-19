#!/usr/bin/env node
//
// Print the official MLB roster status the app sees for a player, and/or every distinct status
// code currently in use across the league.
//
// Why this exists: the IL-swap gate (fetchPlayerILStatus in server.js) accepts a drop only when
// the player's current roster entry matches MLB_IL_STATUS_CODES (D7/D10/D15/D60) or has
// "injured" in its description. Anything else — Restricted List, Suspended, Paternity,
// Bereavement — fails that test, so the swap is rejected with "not on the official MLB injured
// list". Before widening the gate, you want the code and description MLB actually returns for
// that status, verbatim, rather than a guess. That is what this prints.
//
// It hits the same endpoint the server does (/api/v1/people/:id?hydrate=rosterEntries) and picks
// the "current" entry with the same rule, so its verdict line is what the swap form would do.
//
// Usage:
//   node scripts/mlb-roster-status.js "Ketel Marte"
//   node scripts/mlb-roster-status.js 606466
//   node scripts/mlb-roster-status.js --sweep            # every non-Active status in the league
//   node scripts/mlb-roster-status.js --sweep --all      # include Active too
//   node scripts/mlb-roster-status.js "Ketel Marte" --json
//
// Reads nothing and writes nothing — network only.

const path = require('path');

const REPO = path.join(__dirname, '..');
const MLB_API_BASE = process.env.MLB_API_BASE || 'https://statsapi.mlb.com';

// The gate in server.js, copied here only so this script can REPORT its verdict. This is a
// diagnostic mirror, not a second source of truth: if server.js changes, update it here too.
const MLB_IL_STATUS_CODES = new Set(['D7', 'D10', 'D15', 'D60']);

async function mlbApiFetch(apiPath) {
  const resp = await fetch(`${MLB_API_BASE}${apiPath}`);
  if (!resp.ok) throw new Error(`MLB API ${resp.status}: ${apiPath}`);
  return resp.json();
}

// Same selection rule as fetchPlayerILStatus: an explicitly active entry, else the newest
// open-ended one.
function currentEntry(entries) {
  return (
    entries.find((e) => e.isActive === true) ||
    entries
      .filter((e) => !e.endDate)
      .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))[0] ||
    null
  );
}

function gateVerdict(status) {
  if (!status || (!status.code && !status.description)) {
    return { onIL: null, why: 'no current roster entry status — the gate FAILS OPEN (unverified)' };
  }
  const byCode = MLB_IL_STATUS_CODES.has(status.code);
  const byText = /injured/i.test(status.description || '');
  return {
    onIL: byCode || byText,
    why:
      `code ${JSON.stringify(status.code)} ${byCode ? 'IS' : 'is NOT'} in MLB_IL_STATUS_CODES; ` +
      `description ${JSON.stringify(status.description)} ${byText ? 'matches' : 'does not match'} /injured/i`,
  };
}

async function teamList() {
  const data = await mlbApiFetch('/api/v1/teams?sportId=1');
  return (data.teams || []).filter((t) => t.sport && t.sport.id === 1);
}

// fullRoster includes players who are not active — IL, restricted, suspended — which is exactly
// the population we are trying to enumerate. The 40-man and active rosters would hide them.
async function fullRoster(teamId) {
  const data = await mlbApiFetch(`/api/v1/teams/${teamId}/roster?rosterType=fullRoster`);
  return data.roster || [];
}

async function resolveByName(name) {
  const { normalizeName } = await import('file://' + path.join(REPO, 'js', 'utils.js'));
  const target = normalizeName(name);
  const season = new Date().getFullYear();

  // Path 1: the season player catalog, the same fallback the server uses to map an unmapped name.
  try {
    const data = await mlbApiFetch(`/api/v1/sports/1/players?season=${season}`);
    const hits = (data.people || []).filter((p) => normalizeName(p.fullName) === target);
    if (hits.length === 1) return { id: hits[0].id, name: hits[0].fullName, via: 'season catalog' };
    if (hits.length > 1) {
      throw new Error(
        `${hits.length} players match "${name}" in the ${season} catalog (${hits
          .map((p) => p.id)
          .join(', ')}) — pass the id instead.`
      );
    }
  } catch (e) {
    if (/players match/.test(e.message)) throw e;
    console.error(`  (catalog lookup failed: ${e.message})`);
  }

  // Path 2: sweep the 30 full rosters. Slower, but it sees players the season catalog can miss.
  console.error('  (not in the season catalog — scanning full rosters)');
  for (const team of await teamList()) {
    for (const entry of await fullRoster(team.id)) {
      const person = entry.person || {};
      if (normalizeName(person.fullName || '') === target) {
        return { id: person.id, name: person.fullName, via: `${team.abbreviation} full roster` };
      }
    }
  }
  throw new Error(`No MLB player found for "${name}".`);
}

async function reportPlayer(who, asJson) {
  const resolved = /^\d+$/.test(who) ? { id: Number(who), name: null, via: 'id argument' } : await resolveByName(who);

  const data = await mlbApiFetch(`/api/v1/people/${resolved.id}?hydrate=rosterEntries`);
  const person = (data.people || [])[0] || {};
  const entries = person.rosterEntries || [];
  const current = currentEntry(entries);
  const status = current && current.status;
  const verdict = gateVerdict(status);

  if (asJson) {
    console.log(
      JSON.stringify({ id: resolved.id, name: person.fullName || resolved.name, entries, current, verdict }, null, 2)
    );
    return;
  }

  console.log(`\n${person.fullName || resolved.name || resolved.id} (id ${resolved.id}, via ${resolved.via})`);
  console.log(`Team: ${(person.currentTeam && person.currentTeam.name) || '—'}`);
  console.log(`\nAll roster entries (newest first):`);
  const sorted = [...entries].sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  for (const e of sorted) {
    const s = e.status || {};
    const team = (e.team && (e.team.abbreviation || e.team.name)) || '—';
    console.log(
      `  ${e.startDate || '????-??-??'} → ${e.endDate || 'open'}  ` +
        `${team.padEnd(4)}  code=${JSON.stringify(s.code)} description=${JSON.stringify(s.description)}` +
        `${e.isActive === true ? '  [isActive]' : ''}`
    );
  }
  if (!sorted.length) console.log('  (none)');

  console.log(`\nCurrent entry the swap gate would read:`);
  console.log(`  code:        ${JSON.stringify(status && status.code)}`);
  console.log(`  description: ${JSON.stringify(status && status.description)}`);
  console.log(
    `\nIL-swap gate verdict: ${verdict.onIL === null ? 'UNVERIFIED' : verdict.onIL ? 'ALLOWED' : 'REJECTED'}`
  );
  console.log(`  ${verdict.why}`);
}

async function reportSweep(includeActive) {
  const teams = await teamList();
  const seen = new Map();
  for (const team of teams) {
    for (const entry of await fullRoster(team.id)) {
      const s = entry.status || {};
      const key = `${s.code}|${s.description}`;
      if (!seen.has(key)) seen.set(key, { code: s.code, description: s.description, players: [] });
      seen.get(key).players.push(`${(entry.person || {}).fullName} (${team.abbreviation})`);
    }
  }
  const rows = [...seen.values()]
    .filter((r) => includeActive || r.code !== 'A')
    .sort((a, b) => b.players.length - a.players.length);

  console.log(`\nDistinct roster statuses across ${teams.length} full rosters:\n`);
  for (const r of rows) {
    const verdict = gateVerdict(r);
    console.log(
      `  code=${String(JSON.stringify(r.code)).padEnd(8)} description=${String(JSON.stringify(r.description)).padEnd(28)} ` +
        `${String(r.players.length).padStart(4)} players   IL gate: ${verdict.onIL ? 'ALLOWED' : 'REJECTED'}`
    );
    console.log(`      e.g. ${r.players.slice(0, 3).join(', ')}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const sweep = args.includes('--sweep');
  const includeActive = args.includes('--all');
  const who = args.find((a) => !a.startsWith('--'));

  if (!sweep && !who) {
    console.error('Usage: node scripts/mlb-roster-status.js "Ketel Marte" | <mlbId> | --sweep [--all]');
    process.exitCode = 1;
    return;
  }
  if (who) await reportPlayer(who, asJson);
  if (sweep) await reportSweep(includeActive);
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exitCode = 1;
});
