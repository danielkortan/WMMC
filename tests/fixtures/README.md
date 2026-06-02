# Test fixtures

Sanitized snapshots of real league data, safe to commit, for troubleshooting
and unit tests.

## Generating `db.sample.json`

From a machine that has a real `db.json` (your local server or the Render disk):

```bash
npm run sanitize:db
# or: node scripts/sanitize-db.js [input] [output]
```

This reads `db.json` and writes `tests/fixtures/db.sample.json` with:

- **all passwords removed**
- **all emails pseudonymized** (e.g. `cam.mccallum@example.com`), keeping
  referential integrity so a manager's email still matches the email on their
  swaps and audit entries

Everything else — rosters, `roster_dates`, swaps, weekly/daily stats — is left
intact.

## Where the real `db.json` lives

On Render the live data is **not** at the repo root — `render.yaml` sets
`DB_PATH=/var/data/db.json` on the persistent disk, and `server.js` reads
`process.env.DB_PATH || ./db.json`. It is also mirrored to Upstash Redis under
the key `wmmc_db`. Pick whichever route below is easiest.

### Route A (recommended): locally, pulling from the Upstash backup

Works without Render Shell and without deploying — you only need the branch with
this script plus the two `UPSTASH_*` values from your Render env vars.

```bash
# pull the live DB from Upstash into a local db.json (gitignored)
export UPSTASH_REDIS_REST_URL="https://...upstash.io"
export UPSTASH_REDIS_REST_TOKEN="..."
curl -s "$UPSTASH_REDIS_REST_URL/get/wmmc_db" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).result)' > db.json

npm run sanitize:db                       # -> tests/fixtures/db.sample.json
git add tests/fixtures/db.sample.json
git commit -m "Update sanitized db fixture" && git push
```

### Route B: Render Shell

Needs a paid instance (the Shell tab is not on the free tier), and the script
must already be on the deployed branch. Point it at the disk path, then copy the
output into your local repo and commit (Render's shell has no git push creds):

```bash
node scripts/sanitize-db.js /var/data/db.json /tmp/db.sample.json
cat /tmp/db.sample.json   # copy into tests/fixtures/db.sample.json locally, then commit
```

## Rules

- **Never commit the raw `db.json`.** It contains passwords and is gitignored.
  Commit only the sanitized output.
- Re-run the script and re-commit the fixture whenever you need fresher data.
- Player and manager **names are not secret** (they already live in
  `managers_seed.json`), so they are kept as-is for readable fixtures.
