# Test fixtures

`staging-seed.json` is a **fully synthetic** season (invented managers, players, and
deterministic pseudo-random stats — no real league data) used to seed the staging
environment so its UI renders. Regenerate it with `node scripts/generate-staging-seed.js`.
The `wmmc-staging` Render service copies it to `db.json` on boot via its Start Command.

`db.sample.json` is a sanitized snapshot of the live league DB — **all passwords
removed** and **all emails pseudonymized** (e.g. `cam.mccallum@example.com`,
with referential integrity kept so a manager's email still matches their swap
and audit entries). Everything else — rosters, `roster_dates`, swaps,
weekly/daily stats — is intact.

It is committed so every Claude session and every unit test has current league
data to work with on a fresh clone. It is safe to commit because the repo is
private and the file contains no secrets.

## Easiest way to keep it fresh: the GitHub Action (one-time setup)

A workflow (`.github/workflows/refresh-db-fixture.yml`) pulls the live DB from
the Upstash backup, sanitizes it, and commits this file for you.

1. **Add two repository secrets** — GitHub repo → **Settings** → **Secrets and
   variables** → **Actions** → **New repository secret**. Create:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

   Copy both values from your Render service's environment variables. A
   **read-only** Upstash REST token is enough (create one in the Upstash
   console if you want to limit it).

2. **Run it** — GitHub repo → **Actions** tab → **Refresh sanitized DB
   fixture** → **Run workflow** (run it on `main`). It commits the updated
   fixture if anything changed.
3. (Optional) Uncomment the `schedule:` block in the workflow to refresh
   automatically once a day.

> The workflow only appears in the Actions tab once it is on the `main` branch,
> so merge it first.

## Other ways to generate it

**Locally from the Upstash backup** (same as the Action, run by hand):

```bash
export UPSTASH_REDIS_REST_URL="https://...upstash.io"
export UPSTASH_REDIS_REST_TOKEN="..."
npm run refresh:fixture
git add tests/fixtures/db.sample.json && git commit -m "Refresh fixture" && git push
```

**From an existing `db.json` file** (e.g. on the Render disk at
`/var/data/db.json`):

```bash
npm run sanitize:db                                   # uses ./db.json
# or: node scripts/sanitize-db.js /var/data/db.json tests/fixtures/db.sample.json
```

## Where the live data comes from

On Render the real DB is at `/var/data/db.json` on the persistent disk
(`render.yaml` sets `DB_PATH`), and `server.js` mirrors it to Upstash Redis
under the key `wmmc_db` on every write. The Action and `npm run refresh:fixture`
both read that Upstash mirror, so you never have to touch the Render disk.

## Rules

- **Never commit the raw `db.json`.** It contains passwords and is gitignored.
  Commit only the sanitized output.
- Re-run the script and re-commit the fixture whenever you need fresher data.
- Player and manager **names are not secret** (they already live in
  `managers_seed.json`), so they are kept as-is for readable fixtures.
