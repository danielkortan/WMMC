#!/usr/bin/env bash
#
# Pull the live DB from the Upstash backup, sanitize it, and write
# tests/fixtures/db.sample.json. Local alternative to the
# "Refresh sanitized DB fixture" GitHub Action.
#
# Usage:
#   export UPSTASH_REDIS_REST_URL="https://...upstash.io"
#   export UPSTASH_REDIS_REST_TOKEN="..."
#   bash scripts/refresh-fixture.sh
#   git add tests/fixtures/db.sample.json && git commit -m "Refresh fixture" && git push
#
set -euo pipefail

: "${UPSTASH_REDIS_REST_URL:?Set UPSTASH_REDIS_REST_URL (copy from your Render env vars)}"
: "${UPSTASH_REDIS_REST_TOKEN:?Set UPSTASH_REDIS_REST_TOKEN (copy from your Render env vars)}"

cd "$(dirname "$0")/.."

curl -sf "$UPSTASH_REDIS_REST_URL/get/wmmc_db" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).result || "")' > db.json

test -s db.json || {
  echo "Upstash returned empty data for key wmmc_db" >&2
  exit 1
}

node scripts/sanitize-db.js db.json tests/fixtures/db.sample.json
echo "Wrote tests/fixtures/db.sample.json — now: git add it, commit, and push."
