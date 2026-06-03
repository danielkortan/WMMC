# Operations runbook

## Stat syncing

The **MLB Stats API is the source of truth.** It syncs automatically at 4am Eastern
(daily delta for yesterday + a Wednesday full-week correction) and can be driven manually from
the commissioner **MLB API** panel:

- **Sync Now** — current + prior week.
- **Diagnostics** (collapsible) — Backfill from MLB (re-fetch all elapsed weeks), Rebuild
  Totals (recompute weekly rollups from stored daily data, no re-fetch), Data check, Storage,
  Debug player.

## Break glass: re-enable Google Sheets sync

Google Sheets sync is a **dormant server-side fallback**. There is intentionally **no UI** for
it (managers and the normal commissioner view can't see or trigger it). The server endpoints,
scheduler, and parsers remain in `server.js` so it can be re-armed if the MLB API is ever
unavailable. Re-enabling is a deliberate, authenticated API call:

```bash
# 1) Enable + configure (commissioner credentials required)
curl -X POST https://<host>/api/google-sheets/config \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <commissioner-password>' \
  -d '{
        "enabled": true,
        "spreadsheet_id": "<google-sheet-id>",
        "api_key": "<google-api-key>",
        "season": "<year>",
        "sync_time": "05:00"
      }'

# 2) Trigger an immediate sync (optional; otherwise it runs daily at sync_time)
curl -X POST https://<host>/api/google-sheets/sync \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <commissioner-password>' \
  -d '{ "year": "<year>" }'

# 3) Check status
curl https://<host>/api/google-sheets/sync-status
```

To disable again, POST the same config endpoint with `"enabled": false`.

The Google Sheet must have tabs named `Week 1 Batting`, `Week 1 Pitching`, etc. GSheets rows
are tagged `source: 'gsheets'`; the MLB path tags `source: 'mlbapi'`. `dedupeWeeklyRows`
reconciles any overlap, so running both at once is safe but not recommended.

## Storage / durability

- `db.json` lives on the Render **persistent disk** at `/var/data/db.json` (`DB_PATH`). The
  **Storage** button reports the live path and whether durable storage is active.
- Writes are atomic (temp file → fsync → rename), so a crash mid-write can't corrupt the DB.
- Upstash is **not** a viable backup at this DB size — see README. The disk is the source of truth.

## Diagnosing a stats problem

1. **Data check** — per-week stored daily/weekly counts + attribution. Confirms whether a week
   has data at all.
2. **Debug player `<name>`** — everything that determines a player's points: stored records,
   per-week ownership, effective window, drop status, and similar stored names (catches
   roster/feed name mismatches on unmapped players).
3. If weekly totals look stale after a roster correction, **Rebuild Totals** re-derives them
   from stored daily data without re-fetching from MLB.
