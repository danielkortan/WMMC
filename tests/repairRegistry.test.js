import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// R9 gives every repair endpoint an expiry: one that goes a full season without being called is one
// that can be deleted at its close. That decision is only as good as the registry the middleware
// matches against — an endpoint missing from it looks unused forever, and would be deleted on
// evidence that was never collected.
//
// So this checks the registry against the routes themselves, in BOTH directions. It reads server.js
// as text and runs no server code, like tests/serverMirrors.test.js.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function registry() {
  const start = SERVER.indexOf('const REPAIR_ENDPOINTS = [');
  assert.notEqual(start, -1, 'server.js has no REPAIR_ENDPOINTS registry');
  const end = SERVER.indexOf('\n];', start) + 3;
  // eslint-disable-next-line no-eval
  return eval(SERVER.slice(start, end).replace('const REPAIR_ENDPOINTS =', '') + ';');
}

const postRoutes = [...SERVER.matchAll(/app\.post\('(\/api\/[^']+)'/g)].map((m) => m[1]);
const concrete = (route) => route.replace(':year', '2026');

describe('the repair-endpoint registry', () => {
  it('is not empty', () => {
    assert.ok(registry().length >= 10, 'expected at least the ten repair endpoints');
  });

  it('matches exactly one real route per entry', () => {
    for (const entry of registry()) {
      const hits = postRoutes.filter((r) => entry.re.test(concrete(r)));
      assert.equal(
        hits.length,
        1,
        `${entry.name} matched ${hits.length} routes (${hits.join(', ')}) — expected exactly 1`
      );
    }
  });

  it('leaves no repair-shaped route unregistered', () => {
    const repairish = postRoutes.filter((r) =>
      /(backfill|rebuild|recompute|reattribute|reconstruct|purge|prune)/.test(r)
    );
    assert.ok(repairish.length > 0, 'the route scan found nothing — the scan itself has rotted');
    const missed = repairish.filter((r) => !registry().some((e) => e.re.test(concrete(r))));
    assert.deepEqual(
      missed,
      [],
      `these repair routes are not in REPAIR_ENDPOINTS, so they would read as never-called: ${missed.join(', ')}`
    );
  });

  it('gives every entry a name and a description', () => {
    for (const entry of registry()) {
      assert.match(entry.name, /\S/, 'every entry needs a name');
      assert.match(entry.note || '', /\S/, `${entry.name} needs a note saying what it does`);
    }
  });

  it('has no duplicate names', () => {
    const names = registry().map((e) => e.name);
    assert.equal(new Set(names).size, names.length, 'two registry entries share a name');
  });
});
