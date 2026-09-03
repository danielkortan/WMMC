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

To disable again, POST the same config endpoint with `"enabled": false`. That single flag is the
whole off switch — `scheduleGSheetsSync` refuses to arm without `enabled` **and**
`spreadsheet_id` **and** `api_key`, and nothing else in the server reaches Google Sheets on its
own. The MLB cutover also clears the flag itself (`server.js:3622`), which is why a healthy boot
logs `[GSheets] Auto-sync not configured or disabled`.

> This endpoint no longer accepts `season`, and `google_sheets_config` is now only about Google
> Sheets. The app-wide current-season pointer used to live on it — see the next section — which
> meant re-arming this fallback could repoint the whole app as a side effect, and a cleanup pass
> aimed at the importer could take the season pointer with it. Both hazards are gone.

The Google Sheet must have tabs named `Week 1 Batting`, `Week 1 Pitching`, etc. GSheets rows
are tagged `source: 'gsheets'`; the MLB path tags `source: 'mlbapi'`. `dedupeWeeklyRows`
reconciles any overlap, so running both at once is safe but not recommended.

## The current-season pointer

`db.active_season` is the app-wide "which season is live" pointer. The daily scoreboard post,
the season welcome post, the 4am MLB sync, the `/wmmc` slash command, the boot-time player-pool
seed and the auto-advance scheduler all resolve their season from it. Get it wrong and all six
go quiet at once, without an error — each looks up `sd` and bails when it is missing.

```bash
# What is it now, and what seasons exist?
curl https://<host>/api/admin/active-season

# Repoint it (commissioner credentials required). Rejects a season that does not exist,
# because pointing at a missing season silently disables all six automations.
curl -X POST https://<host>/api/admin/active-season \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <commissioner-password>' \
  -d '{ "season": "<year>" }'
```

If `active_season` is unset the server falls back to `db.google_sheets_config.season` (where this
value lived until 2026-08) and then to the current calendar year. A db restored from an older
Upstash backup arrives without `active_season`; the boot migration sets it from the legacy
location on the next start, and the fallback covers the gap in the meantime. Both are logged as
`[Season pointer] ...`.

## Storage / durability

- `db.json` lives on the Render **persistent disk** at `/var/data/db.json` (`DB_PATH`). The
  **Storage** button reports the live path and whether durable storage is active.
- Writes are atomic (temp file → fsync → rename), so a crash mid-write can't corrupt the DB.
- The disk is the source of truth. When `UPSTASH_*` is configured, the server also mirrors a **slim**
  copy to Upstash (live `wmmc_db` key + rolling dated `wmmc_db_bak_<YYYY-MM-DD>` snapshots, ~14-day
  TTL). Slim = full league/standings state minus the regenerable per-game `daily_*` rows, so it fits
  Upstash's ~1 MB limit (`slimForBackup` in `server.js`).
- **Restore** (commissioner only): `GET /api/admin/db-backups` lists available restore points with an
  integrity summary; `POST /api/admin/db-restore?date=YYYY-MM-DD` (body `{ "confirm": "YYYY-MM-DD" }`)
  restores one. It backs up current state first under a `wmmc_db_bak_prerestore_*` key, so a restore
  is itself reversible. Because the snapshot is slim, standings come back immediately but per-game
  daily detail does not — **re-run an MLB backfill (`POST /api/mlb/backfill`) after a restore** to
  repopulate `daily_*` rows. The restore response and Slack alert flag which seasons need it.

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
    // Capture current totals as today's baseline snapshot (no sync) — seeds the
    // trail the next compile diffs against, e.g. to recover when it's empty.
    snapshot: async () => {
      const d = await (
        await fetch('/api/mlb/snapshot', { method: 'POST', headers: h(), body: JSON.stringify({ year: Y }) })
      ).json();
      console.log(d);
      return d;
    },
    // Read-only: list "ghost" players credited to a manager with no legitimate origin
    // (not in their submission or any approved swap) — review before purging.
    ghosts: async () => {
      const d = await (await fetch(`/api/mlb/ghost-audit?year=${Y}`, { headers: h() })).json();
      console.table(
        (d.ghosts || []).map((g) => ({
          manager: g.manager,
          player: g.player,
          points: g.points,
          weeks: (g.weeks || []).length,
        }))
      );
      return d;
    },
  };
  console.log(
    'wmmc ready: wmmc.dates() · wmmc.diff("YYYY-MM-DD","YYYY-MM-DD") · wmmc.mgr("Manager Name") · wmmc.forceSync() · wmmc.snapshot() · wmmc.ghosts()'
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

## Corrections sweep refused a week (Slack alert) — troubleshooting

Every Wednesday the sweep re-syncs each completed week into a throwaway clone and measures it. A
movement over `MLB_CORRECTION_MAX_SWING` (default 15) is **refused and posted**, never written.

**Read the verdict line at the bottom of the post first.** It tells you which of two opposite
problems this is:

- **`Every row that moved changed OWNER, not score`** — a roster fix (an undone swap, a corrected
  date) that never reached this week's cached rows. Closed weeks are never rebuilt, so the stat
  row keeps a stale `manager` and the points sit with the wrong manager or with nobody. **Re-syncing
  the week IS the repair:** `POST /api/mlb/sync { year, round, week }`. Do it — the alert re-fires
  every Wednesday forever otherwise, and the scoreboard is wrong in the meantime.
- **`Every row that moved changed SCORE, with no change of owner`** — a genuine data difference.
  Look before writing: the classic cause is a postponed game counted in its originally scheduled
  week (see MEMORY 2026-08-05, bug 1). Diagnose with `POST /api/mlb/resync-dryrun { year, round,
week }` and open the gamePk before syncing.
- **`row(s) would be ADDED or REMOVED`** — a re-sync would delete stored rows and take their
  points with them. Never write this without knowing which rows.

**A refusal is now recorded, not just posted.** `sd.correction_flags` holds every outstanding
refusal until a later sweep finds that week clean or adopts it. **Closing the season is blocked
while any flag stands** — those weeks feed the bracket, the placements and the permanent record.
The close offers a confirm to override; take it only if you know what the flag is.

To see the current state without waiting for Wednesday, run the sweep as a report — it returns
`outstanding_flags` and `refusal_message` (exactly what Slack would say):

```bash
curl -s -X POST https://wmmc.live/api/mlb/apply-corrections \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  -d '{"year":"2026","dryRun":true}' | jq '{flagged, outstanding_flags, refusal_message}'
```

**Note what `resync-dryrun`'s `player_diffs` cannot show you**: it compares `weekly_score`, so a row
that only changed OWNER does not appear in it at all, and a row the re-sync would DELETE does not
either. The refusal post's row list covers both; the dry run does not.

## Repairing the `manager` field on closed weeks (re-attribution)

The `manager` field on a `weekly_batting` / `weekly_pitching` row says who is credited with that
player that week. It is written in exactly ONE place — `rebuildWeeklyFromDaily`, which only ever
runs for the week being synced — so once a week closes its attribution is frozen. `recomputeAllWeeklyScores`
recomputes every week's SCORE and never touches it. `POST /api/seasons/:year/reattribute-weekly` is
the only thing that can fix one.

**It is DRY RUN by default.** An apply is refused with a 409 if it would move any manager's total,
because re-attribution is a labelling repair and a totals change means either it is finding real
lost points or the derivation is wrong. `force: true` overrides; read the changes first.

**A large `released` count is normal and is not a red flag.** `managerWeekSubtotal` never trusted
`manager` — the `eligible` set (roster_dates + the week arrays + the swap log) decides which rows a
manager may claim — so a row stamped with a manager who did not hold that player was already
filtered out of his subtotal. Releasing it changes no score. Judge the run by `totals_delta`, not by
the direction of the changes. (The 2026 season's repair relabelled 1,295 rows, 1,290 of them
releases, and moved exactly zero points.)

What it DOES fix is every surface that reads a row directly rather than through the subtotal: Slack's
Best/Worst lines, the Live tab, roster listings, and the Season Stats leaderboards.

On **wmmc.live**, logged in as commissioner, DevTools (F12) → Console. Paste this once; it runs
immediately. Change `apply: true` to `apply: false` for a dry run.

```js
(async () => {
  const Y = String(new Date().getFullYear());
  const res = await fetch(`/api/seasons/${Y}/reattribute-weekly`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Email': localStorage.wmmc_logged_in_email,
      'X-User-Password': localStorage.wmmc_logged_in_password,
    },
    body: JSON.stringify({ apply: true }),
  });
  const d = await res.json();
  window.wmmcReattr = d;

  if (res.status === 409) {
    console.error('REFUSED — this would move points, so nothing was written:');
    console.error(d.error);
    console.table(d.totals_delta);
    return;
  }
  if (!res.ok) return console.error('Failed:', res.status, d.error || d);

  const s = d.summary || {};
  console.log(
    `%c${d.applied ? 'APPLIED' : 'DRY RUN'} — ${s.total} rows relabelled across ${(s.weeks || []).length} weeks`,
    'font-weight:bold;font-size:13px'
  );
  console.table({
    claimed: s.claimed,
    'changed hands': s.moved,
    released: s.released,
    'shared weeks': s.contested,
  });

  console.log('Per-manager totals delta (empty = no score moved):');
  console.table(d.totals_delta);

  const notReleased = (d.changes || []).filter((l) => !/ → nobody$/.test(l.replace(/ \[shared week\]$/, '')));
  console.log(`The ${notReleased.length} changes that give a row to a manager:`);
  for (const l of notReleased) console.log('  ' + l);

  if (d.skipped_weeks && d.skipped_weeks.length) console.warn('Skipped weeks:', d.skipped_weeks);
  console.log(
    `All ${(d.changes || []).length} lines are in window.wmmcReattr.changes — e.g. copy(wmmcReattr.changes.join('\\n'))`
  );
})();
```

Every applied change is logged server-side as `[Reattribute] …` and recorded in the audit log under
`reattribute_weekly` with the `totals_delta`.

## Diagnosing a stats problem

1. **Data check** — per-week stored daily/weekly counts + attribution. Confirms whether a week
   has data at all.
2. **Debug player `<name>`** — everything that determines a player's points: stored records,
   per-week ownership, effective window, drop status, and similar stored names (catches
   roster/feed name mismatches on unmapped players).
3. If weekly totals look stale after a roster correction, **Rebuild Totals** re-derives them
   from stored daily data without re-fetching from MLB.

## Eligibility shadow — is the live derivation still right?

There is now ONE answer to "who was rostered this week": `weekRosterWindows`, which `server.js` and
`app.js` both consume. What it replaced was an `eligible` SET built by unioning five heuristics,
which each file had its own slightly different copy of — **43 of the 98 entries in `MEMORY.md` are
those disagreeing.**

**The old union is still in `server.js` as `managerWeekSubtotalLegacy`, and it is not dead code.** It
is the permanent control this endpoint measures the live path against. Run it after any change that
touches rosters, swaps, dates or scoring — it is the cheapest before/after totals vet in the repo,
and it works on any season.

```bash
curl -s https://wmmc.live/api/seasons/2026/eligibility-shadow \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  | jq '{clean, disagreements, totals_delta, client_totals_delta, prior_period_via_array}'
```

**Read-only. It scores the season twice and writes nothing.** Expect it to take several seconds on a
full season — it is roughly two `captureScoreSnapshot` passes. It does not clone the season, so it is
not the shape that took production down in #460.

What to look at, in order:

- **`client_totals_delta`** — read this FIRST, because it is not a proposal. It is the app's
  scoreboard against the server's certified totals, **today**. The browser is not sent daily rows,
  so `rowScore` (app.js) cannot clip to a window: it reads the stored `weekly_score`, or the
  `manager_scores` split when the server wrote one — and `applyManagerScoreSplits` writes that split
  only when TWO OR MORE managers claim the player that week. So wherever the server's eligibility set
  claims a player it then clips to zero, the client has nothing to read but the full weekly score.
  **A non-zero entry here is a live discrepancy, not a plan.**
- **`totals_delta`** — every manager whose total differs between the live path and the control.
  **Empty is the goal**, and it was empty on 2026 when the switch was made.
- **`disagreements`** — manager-weeks where the two differ at all, including where they agree on
  points but not on who was claimed. A non-zero count with an empty `totals_delta` is the common and
  benign case: the control's looser set claims a player it then scores at zero. On 2026 there are
  twelve, one per manager.
- **`only_legacy`** on each entry — players the old path claims and the windows do not. The
  dangerous direction, and the one to read by eye.
- **`only_windows`** — usually a player the additive roster-array cache forgot.
- **`prior_period_via_array`** — how often the one asymmetry the extraction deliberately preserved
  actually fires (a holdover whose only date event is in a prior period, put back by the roster
  array). Zero means it can be narrowed safely; a non-zero count is a data anomaly to look at first.

Each `detail` entry carries all three numbers for the manager-week — `legacy` (what the server
scores now), `candidate` (what the windows would score) and `client` (what the browser shows) —
plus `delta` and `client_delta` against the legacy figure.

`?limit=N` bounds the `detail` array (default 50, max 500); `detail_truncated` says how many were
left out.

**The switch moved both sides at once**, because `managerWeekSubtotal` exists in `app.js` too and it
is what renders the scoreboard the league reads. Moving one alone would guarantee a window where the
app and the server disagree. The client column is how that stays checkable.

Run it against the **frozen 2026 season**: the right answer there is already known, because it is
what the league played all year.

## Pruning the roster arrays

`rebuildRosterArraysFromDates` has always been purely **additive**: it pushes each week's active
players into `sd.rosters[manager][week]` and never removes anyone. So a player the dates say was
dropped stays in that week's array forever, and the surfaces that read an array directly — roster
listings, the Live tab, `findManagerForPlayerWeek`, Slack's Best/Worst — keep showing him.

```
POST /api/seasons/:year/prune-roster-arrays   { dryRun?: true }
```

**DRY RUN BY DEFAULT.** Pass `{"dryRun": false}` to write. Idempotent — a second run removes nothing.

### The pruned set is the WINDOWS, not "players with a live add_date"

This distinction is the whole reason the change was deferred until now, and it is worth
understanding before running it.

The array is the **fallback** `weekRosterWindows` uses for a player who has no date event anywhere —
an original-draft player, or a week carried forward before dates were tracked. Replacing the array
with dates-only actives would delete exactly those players and **lose their points**.

Taking the keep-set from `weekRosterWindows` — the one derivation the scoreboard now scores from —
keeps them by construction. It is also what makes the operation idempotent: the fallback players are
still in the array on the next run, so the second pass computes the identical set.

**This is not theoretical.** Running it against a fixture with a dates-only keep-set refused with a
409 and a `-378` delta for one manager: his array held a holdover whose only date event was in a
prior period. The totals gate caught it and wrote nothing.

### Expect an empty totals delta

The arrays are a derived cache the scoring path no longer reads, so pruning them must move nothing.
The endpoint captures per-manager totals before and after and **refuses to write on any difference at
all** — same idiom as the archive. A totals change means the pruned set is wrong, not that the prune
is finding lost points.

```bash
curl -s -X POST https://wmmc.live/api/seasons/2026/prune-roster-arrays \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  -d '{}' | jq '{totals_check, totals_delta, players_removed, removals}'
```

Read `removals` by eye before applying — it names every manager, week and player.

## Starting the next season

**One action, in the admin panel: "Create New Season".** It previews what will happen, asks once,
and then does all three steps:

1. Creates the next year's season — managers, pool assignments and credentials carry forward;
   rosters, player pools, stats and swap history start clean.
2. Points every automation at it (`active_season`).
3. **Archives the season that was active**, at tier 4.

```
POST /api/admin/start-next-season   { year?, tier?, archivePrior?, dryRun?, force? }
```

Dry run by default; the button runs the dry run first and shows you its result in the confirm.

### Why these are one action

They used to be three things in a required order, and nothing connected them. "Create New Season"
made the season and told you to go and switch the selector; moving `active_season` was a separate
control; and the archive could not run until that pointer had moved, because **"not the active
season" is one of the archive's four preconditions**. So the archive was the step that got
forgotten — which is the whole reason a finished season sat at full size.

### The archive step can skip, and that is deliberate

Step 3 goes through the same planner as `POST .../archive` — the same four preconditions and the
same totals gate. A prior season that is not closed, has a refused stat correction, or shows rollup
drift is **skipped with its reason**, never forced.

Steps 1 and 2 still happen. A season that cannot be archived today can be archived later with
`POST /api/seasons/:year/archive`; blocking the new season on it would be the wrong trade.

The confirm dialog names the outcome either way — either the rows and megabytes the archive will
save, or the reason it is being skipped.

### If you want the steps separately

They all still exist on their own: `POST /api/admin/active-season` moves the pointer,
`POST /api/seasons/:year/archive` archives. The combined endpoint takes `archivePrior: false` to do
just the first two.

## Archiving a finished season

`js/statRetention.js` stops 85% of stat rows being written from 2027 onward. This is the other half:
the one-time compaction of a season already written. On production 2026 that is 15.59 MB down to
**1.82 MB**.

```
POST /api/seasons/:year/archive   { dryRun?: true, tier?: 1|2|3|4, force?: true }
```

**DRY RUN BY DEFAULT.** Pass `{"dryRun": false}` to write.

### The tiers are cumulative

| Tier |                                                          | 2026    | Saves  |
| ---- | -------------------------------------------------------- | ------- | ------ |
| 1    | dailies filtered to rostered player-days                 | 5.21 MB | −10.38 |
| 2    | + weeklies filtered to rostered players                  | 2.83 MB | −2.38  |
| 3    | + drop derived caches, shrink pools and maps             | 2.74 MB | −0.09  |
| 4    | + trim the duplicated `cumulative` and zero-valued stats | 1.82 MB | −0.92  |

Tier 3 is nearly worthless and tier 4 saves ten times as much. **If you only take two steps, take 1
and 4** — which is what tier 4 does, since they are cumulative. Tier 4 is the default.

### It proves itself rather than asserting

The whole design rests on one claim: every row the scoreboard can reach belongs to a rostered player
on a rostered day. So the endpoint captures per-manager totals with `captureScoreSnapshot` before and
after, and **refuses to write on any difference at all**. `force` does not override that one — a
compaction that moves a point is not a compaction. Compaction is correct exactly when it is
invisible.

The keep-set comes from `weekRosterWindows` over every manager × every scheduled week — the same
derivation the scoreboard scores from — never from the `manager` field on a stat row.

### Four preconditions, all of them

1. `season_closed` is set (run `POST /close` first).
2. No outstanding refused stat corrections.
3. No rollup drift — **do not freeze a season that disagrees with itself.**
4. It is not the active season — point `active_season` elsewhere first.

`force: true` overrides these four. It does not override the totals check.

### Run it

```bash
# Dry run first, every time. Read totals_delta and totals_check.
curl -s -X POST https://wmmc.live/api/seasons/2026/archive \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  -d '{"tier":4}' | jq '{totals_check, totals_delta, rows_before, rows_after, mb_before, mb_after, reduction}'

# Then write.
  -d '{"tier":4,"dryRun":false}'
```

**Take a backup first** — `POST /api/admin/backups` — and verify the frozen views the same day.

### After archiving

`sd.archived` is a hard gate. `POST /api/mlb/rebuild-weeklies`, `POST .../recompute-scores`,
`POST /api/mlb/apply-corrections`, `POST /api/mlb/sync` and `POST .../reopen` all refuse with a 409,
because every one of them rebuilds from the daily rows and those are now a subset. **This is the one
way the archive can lose points, and the gate is what prevents it.**

To undo: `POST /api/mlb/backfill` re-fetches the season from the MLB Stats API — which is what made
dropping the rows safe in the first place — and clears `sd.archived` on success. Only then can the
season be reopened or rebuilt.

### What is lost

The What If sandbox can only score players somebody actually rostered, on an archived season.
League-wide leaderboards lose their free-agent lines. `OFFSEASON_ARCHIVE_PLAN.md` §7 spells out the
trade and the alternatives; archiving at tier 1 keeps every weekly row if the sandbox matters more
than the megabytes.

## Sign-in and passwords

### Passwords are stored hashed

Stored as `scrypt$<salt>$<key>`, so a copy of `db.json` — or a backup, or a stray log line — is no
longer a copy of everyone's credentials.

**No migration step, and no possibility of a lockout.** `verifyPassword` accepts both formats
forever: a stored value that is not in the hash format is compared as plaintext. A plaintext password
is upgraded the first time its owner signs in with it, and only after the new hash has been checked
to verify against that same password — so a bug in the hashing can never persist a credential nobody
can use. The boot log says how many are still plaintext.

### `LOGIN_PASSWORD` no longer has a published default

It used to default to a literal string committed to this repository, which meant anyone who read the
repo could sign in as any manager who had not set their own password.

**When `LOGIN_PASSWORD` is unset, the fallback is now random per boot** — nobody can guess it, and
nobody who had a real password is affected. Managers with no password of their own cannot sign in at
all until one is set for them, which is the correct posture but must not be a surprise: the boot log
**names them**.

```
[Auth] LOGIN_PASSWORD is NOT SET and 10 active manager(s) have no password of their own, so they
CANNOT SIGN IN: … Set LOGIN_PASSWORD in the environment, or give each of them a password with
POST /api/managers/:email/password.
```

`render.yaml` declares `LOGIN_PASSWORD` with `sync: false`, so it is set per-service in the Render
dashboard. **Check it is set there** — production and staging separately.

To give one manager their own password instead:

```bash
curl -s -X POST https://wmmc.live/api/managers/<email>/password \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  -d '{"password":"..."}'
```

### Failed sign-ins are throttled

Ten failures from one IP inside fifteen minutes returns `429` for the rest of that window. A success
clears the counter, so mistyping a few times never matters. The pre-existing `rateLimit()` covers
mutating verbs only — a password could otherwise be guessed as fast as the network allowed by
hammering any authenticated GET.

If a commissioner locks themselves out, the window is fifteen minutes; a restart also clears it,
since the counter is in memory.

## Stat retention — storing only players somebody rostered

85.5% of the rows in `db.json`, and 83.2% of its bytes, are per-game stats for players nobody in
this league ever rostered. The sync writes a row for every player in every game it fetches. The cost
is not the disk (a gigabyte, about a quarter a month) — it is that `readDB()` parses the whole file
on every request, twice on an authenticated one, against a 400 MB heap on a 512 MB instance.

`sd.stat_retention` turns that off for a season. **Default `'all'`, which is the behaviour this app
has always had.** Set it to `'rostered'` and the four sync paths (the 4am daily sync, a manual week
sync, and both Google Sheets processors) skip any player who is not in the season's keep-set.

**The keep-set is deliberately permissive** — under-keeping loses points, over-keeping costs bytes,
and those are not the same kind of mistake. A player is kept if he appears in ANY of: the roster
arrays, `roster_dates`, either side of any swap **including a pending one**, any submission
including one awaiting approval, or `sd.held_players`. Pending swaps matter: one approved on
Thursday can be stamped with a Tuesday `add_date`, and Tuesday's rows have to already exist for
that to score.

It also **stands itself down** below a keep-set of 40 players (`RETENTION_MIN_KEEP`) — a season
that small is far more likely half-loaded than genuinely tiny, and filtering against it would throw
away a week of real stats. Every sync logs what it did: `[Retention] PP1 Week 2: kept 168 players,
declined 1,204 unrostered row(s)`.

### Check what it would cost, before turning it on

```bash
curl -s https://wmmc.live/api/seasons/2027/stat-retention \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' | jq
```

`rows_that_would_not_be_written` is measured against the rows already stored, so it is this season's
own number rather than an estimate.

### Turn it on

```bash
curl -s -X POST https://wmmc.live/api/seasons/2027/stat-retention \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  -d '{"mode":"rostered"}' | jq
```

This is **forward-looking**: it changes what the next sync writes and touches not one stored row,
which is why it needs no before/after totals vet. Turning it off (`{"mode":"all"}`) is always safe.

### The one hazard, and its repair

A player **nobody** had — not rostered, not submitted, not in any swap — who is then given a
**back-dated** add by a commissioner. His rows for those days were never written, so he would score
zero for them.

The repair is the one that already exists for a stale week:

```bash
curl -s -X POST https://wmmc.live/api/mlb/sync \
  -H 'Content-Type: application/json' \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' \
  -d '{"year":"2027","round":"PP1","week":"Week 2"}' | jq
```

That re-fetches the week from the MLB Stats API and now keeps him, because the keep-set changed the
moment he was rostered. **This is why retention is a filter over regenerable data and not a delete.**

To keep a player ahead of anyone rostering him (a call-up you want tracked), add him explicitly —
he then survives every filter for the rest of the season:

```bash
-d '{"hold":["Roman Anthony"]}'
```

## The local backup trail — dated copies of what cannot be re-fetched

Render takes a disk snapshot every 24 hours and keeps seven days. That covers total corruption. It
does **not** cover the shape of failure this app actually produces:

- **Seven days of memory.** The 8/31 misattribution went unnoticed for twelve.
- **All-or-nothing.** Rolling back to recover one manager's swap log throws away every stat sync and
  every other manager's swaps since. In-season you would never actually press it.
- **Opaque.** You cannot see what a snapshot holds without restoring it.

The trail is the answer to those three. `<db dir>/backups/wmmc-YYYY-MM-DD.json`, one per day at
**11pm Eastern** — but only when something actually changed. It holds only what exists nowhere else:
`roster_dates`, `rosters`, the swaps, the submissions, the roasts, the hand-set `schedule_dates`,
the `mlb_ids` map, the audit log, and manager identities. **Passwords are stripped**, following
`managers_seed.json`'s rule — a commissioner re-issues one in a minute, and a dated trail of copies
would multiply the exposure of a plaintext credential.

**A copy is 877 KB on production, and one is written only when its content differs from the newest
one on disk** (`created_at` and `last_saved_at` excluded — both are timestamps every run bumps).
Written blindly a year would be ~320 MB of a 1 GB disk; through the offseason nothing changes, so it
costs nothing. That makes the trail a list of **change points**, which is a better answer to "when
did this change?" than 364 identical files with the one interesting day buried among them.

`last_run` on the listing endpoint records every run, written or not — that is how you tell **"it
ran and had nothing to say"** from **"it never ran"**. The first is a quiet week; the second is a
broken scheduler.

Every copy also carries **`certified_totals`** — each season's per-manager totals from
`captureScoreSnapshot`, the same function every before/after vet in this repo uses. That is what
makes a restored file checkable rather than merely present.

Everything omitted is regenerable, and the payload says so in its own `omitted` block: the stat
rows re-fetch from the MLB Stats API, the pools re-bootstrap, the weekly rollups rebuild from the
dailies, the odds and hot takes recompute.

### List what you have

```bash
curl -s https://wmmc.live/api/admin/backups \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' | jq
```

Each entry reports the things a person actually asks about — how many swaps, how many roster
events, how many managers have a certified total — not just a byte count.

### Answer "when did this change?"

This is the reason the trail exists, and the one thing no whole-disk snapshot can do at any
retention:

```bash
curl -s https://wmmc.live/api/admin/backups/2026-08-19/diff/today \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' | jq
```

`to` can be another date or the literal `today` (compares against the live database, writing
nothing). It reports, per season: swaps added, removed, or changed status; roster windows added,
removed, or moved; and every manager whose certified total moved. Bisect with it — halve the
interval until the diff names one day.

### Read one day in full, and repair surgically

```bash
curl -s https://wmmc.live/api/admin/backups/2026-08-19 \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' | jq '.seasons["2026"].swaps'
```

Then put back the one thing that moved, through the normal endpoints. **That is the point:** you
repair the swap log without rolling the machine back and losing every sync since.

### Take one now

```bash
curl -s -X POST https://wmmc.live/api/admin/backups \
  -H 'X-User-Email: <commissioner-email>' \
  -H 'X-User-Password: <password>' | jq
```

Idempotent — the day's file is overwritten — so run it before any change worth being able to undo.

**This does not replace the Upstash mirror or Render's snapshots**, and it is not a whole-database
restore: a copy holds no stat rows, so recovering from one means re-syncing the season from the MLB
Stats API afterwards. It is the surgical half, and the half that remembers longer than a week.

## Season storage report — how big is db.json, and what would an archive save?

Answers "what is the database actually made of" and prices the offseason archive tiers. See
[`OFFSEASON_ARCHIVE_PLAN.md`](OFFSEASON_ARCHIVE_PLAN.md) for what the tiers mean.

**Two ways to run it. The console one needs nothing installed.**

### From the browser (no deploy, no shell)

On **wmmc.live**, logged in as commissioner, DevTools (F12) → Console. Paste this once; it runs
immediately. It reads only — nothing is written.

```js
(async () => {
  const Y = String(new Date().getFullYear());
  const h = () => ({
    'X-User-Email': localStorage.wmmc_logged_in_email,
    'X-User-Password': localStorage.wmmc_logged_in_password,
  });
  const B = (v) => (v === undefined ? 0 : JSON.stringify(v).length);
  const MB = (n) => +(n / 1048576).toFixed(2);
  console.log('Fetching… the daily rows are several MB, give it a moment.');

  const [seasons, daily, disk] = await Promise.all([
    fetch('/api/seasons').then((r) => r.json()),
    fetch(`/api/seasons/${Y}/daily-stats`).then((r) => r.json()),
    fetch('/api/mlb/storage-status', { headers: h() })
      .then((r) => r.json())
      .catch(() => ({})),
  ]);
  const sd = seasons[Y];
  if (!sd) return console.error(`No season ${Y} in the payload.`);

  // Who was rostered, when — from roster_dates + the schedule, never from the sticky
  // `manager` field on a stat row (that is the field this app has had wrong before).
  const sched = sd.schedule_dates || [];
  const s0 = sched[0] && sched[0].start;
  const e0 = sched[sched.length - 1] && sched[sched.length - 1].end;
  const spans = new Map();
  for (const weeks of Object.values(sd.roster_dates || {}))
    for (const players of Object.values(weeks || {}))
      for (const [p, d] of Object.entries(players || {})) {
        const s = (d && d.add_date) || s0,
          e = (d && d.drop_date) || e0;
        if (!s || !e || s > e) continue;
        if (!spans.has(p)) spans.set(p, []);
        spans.get(p).push([s, e]);
      }
  const onDate = (p, dt) => (spans.get(p) || []).some(([s, e]) => dt >= s && dt <= e);
  const inSpan = (p, a, b) => (spans.get(p) || []).some(([s, e]) => s <= b && e >= a);

  const wk = new Map();
  for (const r of [...(daily.batting || []), ...(daily.pitching || [])]) {
    const k = `${r.round}|${r.week}`,
      c = wk.get(k) || { start: r.date, end: r.date };
    if (r.date < c.start) c.start = r.date;
    if (r.date > c.end) c.end = r.date;
    wk.set(k, c);
  }

  const split = (rows, key, isDaily) => {
    const o = { keepN: 0, keepB: 0, dropN: 0, dropB: 0, trimB: 0 };
    for (const r of rows || []) {
      const b = B(r),
        n = r[key],
        sp = wk.get(`${r.round}|${r.week}`);
      const keep = isDaily ? onDate(n, r.date) : sp ? inSpan(n, sp.start, sp.end) : !!r.manager;
      if (!keep) {
        o.dropN++;
        o.dropB += b;
        continue;
      }
      o.keepN++;
      o.keepB += b;
      if (isDaily && r.delta) {
        if (r.cumulative && JSON.stringify(r.cumulative) === JSON.stringify(r.delta))
          o.trimB += B(r.cumulative) + key.length;
        o.trimB += B(r.delta) - B(Object.fromEntries(Object.entries(r.delta).filter(([, v]) => v)));
      }
    }
    return o;
  };

  const dB = split(daily.batting, 'batter', true),
    dP = split(daily.pitching, 'pitcher', true);
  const wB = split(sd.weekly_batting, 'batter', false),
    wP = split(sd.weekly_pitching, 'pitcher', false);

  const disposable = ['playoff_odds', 'bracket_odds', 'hot_takes', 'upload_log'].reduce((s, k) => s + B(sd[k]), 0);
  const shrinkable = ['batters_pool', 'pitchers_pool', 'batters_team', 'pitchers_team', 'mlb_ids'].reduce(
    (s, k) => s + B(sd[k]),
    0
  );

  const seen = B(sd) + B(daily.batting) + B(daily.pitching);
  const t1 = seen - dB.dropB - dP.dropB;
  const t2 = t1 - wB.dropB - wP.dropB;
  const t3 = t2 - disposable - Math.round(shrinkable * 0.9);
  const t4 = t3 - dB.trimB - dP.trimB;

  console.log(`\n=== SEASON ${Y} ===`);
  console.log(`On disk (whole db.json, every season): ${MB(disk.db_size_bytes || 0)} MB`);
  console.log(`This season, as the API exposes it:    ${MB(seen)} MB  (score_snapshots not visible here)\n`);
  console.table(
    Object.entries({ daily_batting: dB, daily_pitching: dP, weekly_batting: wB, weekly_pitching: wP }).map(
      ([k, v]) => ({
        rows: k,
        'rostered rows': v.keepN,
        'rostered MB': MB(v.keepB),
        'free-agent rows': v.dropN,
        'free-agent MB': MB(v.dropB),
        'droppable %': +((100 * v.dropB) / (v.keepB + v.dropB || 1)).toFixed(1),
      })
    )
  );
  console.table(
    [
      ['0 — today', seen],
      ['1 — dailies: rostered player-days only', t1],
      ['2 — + weeklies: rostered players only', t2],
      ['3 — + drop derived caches, shrink pools', t3],
      ['4 — + drop duplicate cumulative and zero stats', t4],
    ].map(([tier, v]) => ({ tier, MB: MB(v), 'of today %': +((100 * v) / seen).toFixed(1) }))
  );
  console.log(`Upstash backup limit is ~1.00 MB. Tier 4 ${t4 <= 1048576 ? 'FITS' : 'does NOT fit'}.`);
  if (spans.size === 0) console.warn('roster_dates was empty — nothing could be classified. Numbers are meaningless.');
})();
```

### From a shell (exact, includes `score_snapshots`)

Needs the repo checked out somewhere that can read a copy of `db.json` — a Render Shell on the
prod service (paid instance types only), or your own machine with a downloaded copy. **The script
must be on the branch you are running from**; it does not exist on `main` until this PR merges.

```
node scripts/season-storage-report.js /var/data/db.json --year 2026
```

`--json` emits the same report as machine-readable JSON. Both forms are read-only.
