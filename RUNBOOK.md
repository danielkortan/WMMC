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

## The local backup trail — dated copies of what cannot be re-fetched

Render takes a disk snapshot every 24 hours and keeps seven days. That covers total corruption. It
does **not** cover the shape of failure this app actually produces:

- **Seven days of memory.** The 8/31 misattribution went unnoticed for twelve.
- **All-or-nothing.** Rolling back to recover one manager's swap log throws away every stat sync and
  every other manager's swaps since. In-season you would never actually press it.
- **Opaque.** You cannot see what a snapshot holds without restoring it.

The trail is the answer to those three. `<db dir>/backups/wmmc-YYYY-MM-DD.json`, one per day at
**11pm Eastern**, a year of them, ~90 MB in total. It holds only what exists nowhere else:
`roster_dates`, `rosters`, the swaps, the submissions, the roasts, the hand-set `schedule_dates`,
the `mlb_ids` map, the audit log, and manager identities. **Passwords are stripped**, following
`managers_seed.json`'s rule — a commissioner re-issues one in a minute, and a dated trail of copies
would multiply the exposure of a plaintext credential.

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
