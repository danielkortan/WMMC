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

## Score-swing guard fired (Slack alert) — troubleshooting

You'll get a Slack message in the notifications channel when a daily compile produces a
suspicious swing:

- **"Score guard BLOCKED a compile — scores NOT saved (drop of 40+ pts)"** — a manager
  dropped ≥40 pts. The new scores were **not** saved; the scoreboard keeps yesterday's
  good numbers until you resolve it.
- **"large upward jump (>200 pts)"** — saved (up is normal), just flagged for a look.

**Quickest path: paste this passphrase into Claude →** `SCOREFIX` (Claude will load these
steps and walk you through them). To do it yourself, follow the steps below.

### One-time setup (per browser page load)

On **wmmc.live**, logged in as commissioner, open DevTools (F12) → Console, paste this once.
It installs `wmmc.*` helpers:

```js
(() => {
  const Y = String(new Date().getFullYear());
  const h = () => ({
    'X-User-Email': localStorage.wmmc_logged_in_email,
    'X-User-Password': localStorage.wmmc_logged_in_password,
    'Content-Type': 'application/json',
  });
  window.wmmc = {
    // List each saved day's per-manager totals (find the day it broke)
    dates: async () => {
      const d = await (await fetch(`/api/mlb/score-guard?year=${Y}`, { headers: h() })).json();
      console.table(
        (d.snapshots || []).map((s) => ({
          date: s.date,
          ...Object.fromEntries(Object.entries(s.totals).map(([m, v]) => [m, v.total])),
        }))
      );
      return d;
    },
    // "What changed?" — player-level diff between two days
    diff: async (from, to) => {
      const d = await (await fetch(`/api/mlb/score-guard?year=${Y}&from=${from}&to=${to}`, { headers: h() })).json();
      console.log(JSON.stringify(d, null, 2));
      return d;
    },
    // Inspect one manager's source records (rosters, dates, swaps, per-week scoring)
    mgr: async (name) => {
      const d = await (await fetch(`/api/diag/manager?name=${encodeURIComponent(name)}`, { headers: h() })).json();
      console.log(JSON.stringify(d, null, 2));
      return d;
    },
    // Accept a legit correction: force a re-sync past the guard
    forceSync: async () => {
      const d = await (
        await fetch('/api/mlb/sync-current', {
          method: 'POST',
          headers: h(),
          body: JSON.stringify({ year: Y, force: true }),
        })
      ).json();
      console.log(d);
      return d;
    },
  };
  console.log(
    'wmmc ready: wmmc.dates() · wmmc.diff("YYYY-MM-DD","YYYY-MM-DD") · wmmc.mgr("Manager Name") · wmmc.forceSync()'
  );
})();
```

### Steps when the guard fires

1. **Read the Slack alert** — note the manager(s) and the before→after totals it lists.
2. **`wmmc.dates()`** — see the saved daily totals; identify the last good day and the bad day.
   (A _blocked_ day isn't saved, so compare the last two good days, or use `wmmc.mgr()` below.)
3. **`wmmc.diff("<lastGoodDay>", "<badDay>")`** — drills down to the exact manager → week →
   player whose points moved. That's the cause.
4. **`wmmc.mgr("<flagged manager>")`** — inspect that manager's rosters, add/drop dates, swaps,
   and per-week scoring if you need more context.
5. **Decide:**
   - **Legit MLB stat correction** (rare, but real downward moves happen) → accept it with
     **`wmmc.forceSync()`**.
   - **Bad data / bug** (wrong swap, bad add/drop date, mis-attribution) → fix the roster/swap/
     date in the app (commissioner roster editor, swaps, date controls) and **`wmmc.forceSync()`**;
     or, if it's not an obvious data-entry mistake, **paste the `wmmc.diff()` and `wmmc.mgr()`
     output to Claude with `SCOREFIX`** and it will pinpoint and patch it.
6. **Confirm** the scoreboard looks right; the next 7am post will carry the corrected numbers.

## Diagnosing a stats problem

1. **Data check** — per-week stored daily/weekly counts + attribution. Confirms whether a week
   has data at all.
2. **Debug player `<name>`** — everything that determines a player's points: stored records,
   per-week ownership, effective window, drop status, and similar stored names (catches
   roster/feed name mismatches on unmapped players).
3. If weekly totals look stale after a roster correction, **Rebuild Totals** re-derives them
   from stored daily data without re-fetching from MLB.
