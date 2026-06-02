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

## Rules

- **Never commit the raw `db.json`.** It contains passwords and is gitignored.
  Commit only the sanitized output.
- Re-run the script and re-commit the fixture whenever you need fresher data.
- Player and manager **names are not secret** (they already live in
  `managers_seed.json`), so they are kept as-is for readable fixtures.
