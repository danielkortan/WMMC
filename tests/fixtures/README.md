# Test fixtures

## `staging-seed.json` — committed, used by the test suite

A **fully synthetic** season (invented managers, players, and deterministic pseudo-random
stats — no real league data). `tests/hypothetical.test.js` reads it, and it seeds the staging
environment so its UI renders. Regenerate it with `node scripts/generate-staging-seed.js`.
The `wmmc-staging` Render service copies it to `db.json` on boot via its Start Command.

> Caveat before you use it to vet a scoring change: it ships **weekly rows only**, no daily
> rows. `computeEffectiveBattingScore` returns `null` without daily rows, which makes a
> whole-season recompute a silent no-op — a broken change will pass. Synthesize daily rows by
> splitting each weekly row's counting stats across the week's dates first.

## `db.sample.json` — NOT committed; generate it when you need it

A sanitized snapshot of the live league DB — **all passwords removed** and **all emails
pseudonymized** (e.g. `cam.mccallum@example.com`, with referential integrity kept so a
manager's email still matches their swap and audit entries). Everything else — rosters,
`roster_dates`, swaps, weekly/daily stats — is intact.

**This file has never been committed to this repo**, on any branch. The tooling below produces
it, but the Action's secrets were never added, so it has never run. Do not assume a fresh clone
has real league data — nothing in `tests/` depends on this file.

### Generating it

**From an existing `db.json`** (e.g. the Render disk at `/var/data/db.json`):

```bash
npm run sanitize:db                                   # uses ./db.json
# or: node scripts/sanitize-db.js /var/data/db.json tests/fixtures/db.sample.json
```

**From the Upstash backup** (no Render access needed):

```bash
export UPSTASH_REDIS_REST_URL="https://...upstash.io"
export UPSTASH_REDIS_REST_TOKEN="..."   # a read-only REST token is enough
npm run refresh:fixture
```

**Via the GitHub Action** — `.github/workflows/refresh-db-fixture.yml` does the same thing and
commits the result for you. To make it work, add both `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` under repo **Settings → Secrets and variables → Actions**, then run
it from the **Actions** tab on `main`. Until those secrets exist it fails fast by design.
Uncomment its `schedule:` block to refresh daily.

## Where the live data comes from

On Render the real DB is at `/var/data/db.json` on the persistent disk (`render.yaml` sets
`DB_PATH`), and `server.js` mirrors it to Upstash Redis under the key `wmmc_db` on every write.
The Action and `npm run refresh:fixture` both read that Upstash mirror, so you never have to
touch the Render disk.

## Rules

- **Never commit the raw `db.json`.** It contains passwords and is gitignored. Commit only
  sanitized output.
- Player and manager **names are not secret** (they already live in `managers_seed.json`), so
  they are kept as-is for readable fixtures.
