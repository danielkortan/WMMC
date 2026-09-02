# Offseason Archive Plan — freezing a closed season

Companion to [`SEASON_ONE_REVIEW.md`](SEASON_ONE_REVIEW.md). Written 2026-09-01, the day after
the 2026 season closed.

**Goal.** Once a season is closed, keep everything needed to render the Scoreboard, My Roster,
the Swap Log and the season archive exactly as they read on closing day — and drop the per-game
stat history for players nobody ever rostered.

---

## 1. Where the money actually is

Be honest about this, because the obvious answer is wrong.

**It is not the disk.** `render.yaml` provisions the minimum 1 GB Render disk (~$0.25/month).
Going from 20 MB to 2 MB saves nothing there, and it never will.

**It is the memory ceiling.** `db.json` is fully parsed on **every request** and fully
re-serialized on **every write**. Measured on a synthesized 19.8 MB season-scale file — production
turned out to be 17.3 MB, so these figures are slightly conservative rather than inflated:

|                               |                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `readFileSync` + `JSON.parse` | **272 ms** (paid twice on authenticated requests — the auth middleware reads the db, then the handler reads it again) |
| Heap per parsed copy          | **45 MB**                                                                                                             |
| `JSON.stringify` on write     | **402 ms**                                                                                                            |
| Peak RSS, one parse + write   | **183 MB**                                                                                                            |

`render.yaml` already carries the scar:

```yaml
# db.json is fully parsed per request and fully re-serialized per write, and the default
# limit (~256 MB on a 512 MB instance) caused the 2026-07-06 OOM crash loop (exit 134)
- key: NODE_OPTIONS
  value: --max-old-space-size=400
```

That is one season against a 400 MB ceiling on a 512 MB instance. **Two seasons is ~40 MB and
~90 MB per parsed copy. Three is the wall.** The saving is not a line item on next month's bill;
it is not being forced onto a larger instance in 2028 — and not spending another July debugging
an OOM crash loop.

**It is not the backup, because there isn't one.** Production reports
`upstash_configured: false`, so `saveToUpstash` has returned immediately every time it has ever
been called. The dated snapshots, `GET /api/admin/db-backups`, `POST /api/admin/db-restore` and
the fixture-refresh workflow are all inert for the same reason. The single Render disk is the only
copy of the league.

The size problem is real but _latent_: turning Upstash on today would not work either, since the
slimmed payload is ~4.83 MB against a ~1 MB cap, and even a tier-4 archive only gets the whole
file to ~3.5 MB (~2.4 MB slimmed).

**The fix is not a bigger backup — it is a smaller one, chosen differently.** `slimForBackup`
strips by SIZE. The right criterion is REPLACEABILITY:

| data                                                      | size    | replaceable?                          |
| --------------------------------------------------------- | ------- | ------------------------------------- |
| daily + weekly stat rows                                  | 15.3 MB | yes — re-fetch from the MLB Stats API |
| pools, team maps, `mlb_ids`                               | ~0.1 MB | yes — re-bootstrap from the catalog   |
| `roster_dates`, `swaps`, submissions, `rosters`, `roasts` | 0.25 MB | **no — exists nowhere else**          |

Losing every stat row in the file costs a re-sync. Losing the swap log costs the season. Back up
the quarter of a megabyte that cannot be rebuilt and the free tier is ten times more than enough,
archived or not. See recommendation **R13** in the review.

**It is egress.** `GET /api/seasons` ships every season's non-daily state to every browser on
every load, and `GET /api/seasons/:year/daily-stats` ships ~15 MB more to anyone who opens Trends
or My Roster — unauthenticated and not rate-limited. Compaction cuts both by an order of
magnitude.

---

## 2. What the frozen views actually need

Derived from reading the render paths, not from guessing.

**Keep, untouched — the scoring invariant's own sources:**

- `roster_dates`, `swaps`, `initial_submissions`, `period_submissions`, `player_dates`
- `schedule_dates`, `name`, `year`, `status`, `season_closed`
- `eliminated`, `confirmed_seeding`, `finalized_rounds`, `losers_dumped`, `advanced_weeks`,
  `auto_advanced_weeks`, `roasts`, `asg_date`, `custom_rules`, `custom_*_scoring`
- `rosters` (a derived cache, but it is what the frozen week views read, and rebuilding it needs
  data we are about to remove — so freeze it as-is)

**Keep, filtered to rostered players:**

- `weekly_batting` / `weekly_pitching` — rows for players some manager held during that week
- `daily_batting` / `daily_pitching` — rows for `(player, date)` pairs where some manager held
  that player on that date
- `batters_team` / `pitchers_team` / `mlb_ids` — restricted to the kept names

**Drop:**

- `score_snapshots` — the swing guard's rolling trail, meaningless once nothing can change.
  Keep the **last** one as the certified-totals record; drop the other 20.
- `playoff_odds`, `bracket_odds`, `hot_takes` — derived caches for a live season
- `upload_log` — keep the last 5 as provenance, drop the rest
- `batters_pool` / `pitchers_pool` — ~1,600 names of the whole MLB active catalog, needed only
  for the live swap form's autocomplete. Replace with the season's rostered names.
- `correction_flags` — but only once resolved; a refused correction must survive (that is exactly
  what `/close` now refuses to certify over)

---

## 3. What it saves

`scripts/season-storage-report.js` (new, read-only) measures this against a real `db.json`:

```
node scripts/season-storage-report.js /var/data/db.json --year 2026
```

It classifies every stat row as rostered or free-agent **from `roster_dates` + `schedule_dates`**
— never from the sticky `manager` field, which is the field that was wrong for twelve days in the
semifinal — and prices four tiers. `RUNBOOK.md` carries a browser-console version that needs no
shell and computes the same report from endpoints the app already serves.

**Measured against production on 2026-09-02.** `db.json` is **17.3 MB** on disk. The 2026 season
as the API exposes it is 15.59 MB; the remaining 1.71 MB is 2026's `score_snapshots` (which the
API strips), the 2025 season, the managers and the audit log.

| Tier |                                                          | Result   | Saves     |
| ---- | -------------------------------------------------------- | -------- | --------- |
| 0    | today                                                    | 15.59 MB | —         |
| 1    | dailies: rostered player-days only                       | 5.21 MB  | −10.38    |
| 2    | + weeklies: rostered players only                        | 2.83 MB  | −2.38     |
| 3    | + drop derived caches, shrink pools and maps             | 2.74 MB  | **−0.09** |
| 4    | + drop the duplicated `cumulative` and zero-valued stats | 1.82 MB  | −0.92     |

Rows, by whether anyone rostered the player:

| array             | rostered        | free agent       | droppable |
| ----------------- | --------------- | ---------------- | --------- |
| `daily_batting`   | 6,294 / 1.77 MB | 25,532 / 7.16 MB | 80.2%     |
| `daily_pitching`  | 1,093 / 0.31 MB | 15,993 / 3.23 MB | 91.4%     |
| `weekly_batting`  | 1,093 / 0.24 MB | 5,510 / 1.14 MB  | 82.7%     |
| `weekly_pitching` | 924 / 0.25 MB   | 8,621 / 1.24 MB  | 85.8%     |

**85.5% of stat rows, and 83.2% of stat bytes, belong to players nobody rostered.**

**Two things the measurement changed.** Tier 3 is nearly worthless — 0.09 MB — because the pools,
team maps, `mlb_ids` and the odds/hot-takes caches together come to about a tenth of a megabyte;
all the size is in the stat rows. And the per-row field trim (tier 4) saves **ten times** what
tier 3 does, which makes it the second-most valuable step rather than a rounding-error extra. If
only two steps are taken, take 1 and 4.

Non-stat 2026 data — rosters, `roster_dates`, swaps, submissions, roasts, the whole scoring
invariant — is **0.25 MB**. Everything the frozen views actually need is already tiny.

The bottom-up estimate that preceded this measurement predicted ~8,000 rostered daily rows against
a real 7,387, and ~1,800 weekly rows against a real 2,017: the row model was sound. The size
estimate was optimistic. An archived 2026 lands at **1.82 MB, an 8.6× reduction**, not the 10–20×
first claimed.

Two of those tiers are free wins on row _shape_, worth taking because they are pure duplication:

- **`cumulative` is byte-identical to `delta`** on every per-game row the MLB sync writes (the
  sync sets `cumulative: gameStats, delta: gameStats`). Every reader already does
  `r.delta || r.cumulative`. Dropping it on archive is **-32% per row**.
- **Zero-valued stat keys.** A typical batting line carries six zeros out of eleven; every reader
  does `d[k] || 0`. Dropping them is **-44% per row** cumulatively.

---

## 4. The design

A new commissioner endpoint, run after `/close`:

```
POST /api/seasons/:year/archive     { dryRun?: true, tier?: 2|3|4, force?: true }
```

**Preconditions — all four, no exceptions.**

1. `sd.season_closed` is set. Archiving an open season is never right.
2. `sd.correction_flags` has no outstanding refusal (the same gate `/finalize-season` and
   `/close` already apply — see `correctionCloseBlock`).
3. `auditWeeklyRollupDrift(sd)` returns no findings. **Do not freeze a season that disagrees with
   itself.** Had this existed on 2026-08-31 it would have blocked the close.
4. `year !== activeSeason(db)`, or the active pointer has already moved on.

**The operation.**

1. `const before = captureScoreSnapshot(sd, todayET).totals`
2. Build the keep-set of `(player, date)` pairs from `managerWeekRosterWindows` for every manager
   × every week — the same derivation the drift audit uses, with the roster array as the same
   explicit fallback for players with no date events at all.
3. Filter the four stat arrays; restrict the team maps, `mlb_ids` and the pools; drop the derived
   caches; trim row fields at tier 4.
4. `const after = captureScoreSnapshot(compacted, todayET).totals`
5. **`assert.deepEqual(before, after)`** — per manager, per week, to the cent. Any difference at
   all: abort, write nothing, report the diff. `force` does **not** override this one.
6. Stamp `sd.archived = { at, tier, kept_rows, dropped_rows, bytes_before, bytes_after }`.
7. Write. (The Upstash mirror still will not fit — see §1. That is a separate decision.)

**`dryRun: true` does 1–5 and reports, writing nothing.** Run that first, every time.

This is the repo's own idiom: it is the before/after per-manager totals vet that `CLAUDE.md`
requires of any change touching rosters or scoring, applied to a change that touches nothing else.
Compaction is correct exactly when it is invisible.

---

## 5. Safety rails

**`sd.archived` is a hard gate.** Once set, refuse:

- `POST /recompute-scores`, `POST /rebuild-weeklies`, `POST /apply-corrections` — they rebuild
  weekly rows from the daily rows, and the daily rows are now a subset. Running any of them on an
  archived season would recompute the standings from truncated data. **This is the one way this
  plan can lose points, and the gate is what prevents it.**
- Every MLB sync path, every write to the stat arrays.

**`POST /reopen` must handle it.** Reopening an archived season is legitimate (a stat correction
arrives in November). Make reopen refuse while `sd.archived` is set and point at a rehydrate step:
`POST /api/mlb/backfill` re-fetches the season's per-game rows from the MLB Stats API, which
restores full fidelity — the data was always regenerable, which is why `slimForBackup` was allowed
to drop it in the first place. Clear `sd.archived` only after a successful backfill.

**Archive one season at a time, never on a timer.** This is a commissioner action with a dry run,
not a cron job.

---

## 6. What is preserved, precisely

Every frozen view keeps working, and here is why:

- **Scoreboard.** Totals come from `managerWeekSubtotal` over the weekly rows, clipped by
  `managerRowScoreForWeek` to each manager's window using that player's daily rows. Every row it
  can reach belongs to a rostered player on a rostered day, so the keep-set is a superset of what
  it reads. Step 5 proves it.
- **My Roster.** Reads `rosters` + `roster_dates` (kept whole) and the per-week stat windows for
  rostered players (kept).
- **Swap Log, submission history, roasts, the bracket, the champion card.** Untouched.
- **Season Stats / accolades / Trends.** Read weekly and daily rows for rostered players — kept.
  Free-agent lines disappear from league-wide leaderboards for archived seasons; that is the
  intended trade.
- **Hall of Fame.** Reads `js/history.js`, not season data.

---

## 7. What is lost — say this out loud before shipping

**The What If sandbox loses full-league fidelity on archived seasons.** `js/hypothetical.js`
scores counterfactual rosters from weekly and daily rows across "the FULL league, so nobody is
unreachable just because they had a quiet season" (`playerSuggestions`). After archiving, a 2026
scenario can only use players someone actually rostered. "What if I'd started Judge instead" stops
being answerable for a closed season.

Three ways to take it, in order of my preference:

1. **Accept it (recommended).** The sandbox's real use is re-litigating your own lineup, and every
   player you or your opponent held is still there. Gate the season selector on `sd.archived` and
   say so in the UI: _"2026 is archived — What If covers rostered players only."_
2. **Archive at tier 1** — keep every weekly row, compact only the dailies. 4.5 MB instead of
   0.8 MB, and league-wide season and per-round totals survive; only day-level detail for
   free agents is lost. A reasonable middle if the sandbox matters to the league.
3. **Keep a season-total sidecar** for every player (name → per-round points, ~1,600 rows,
   ~80 KB) so leaderboards and search stay complete while per-game detail goes. More code, and it
   only half-solves it — the sandbox needs per-week granularity to score a period.

**Also gone:** the score-snapshot trail (so "what did the guard see on August 12" becomes
unanswerable — keep the final snapshot for the certified totals), and the odds history for that
season.

---

## 8. Rollout

1. **Now.** Run `scripts/season-storage-report.js` against production. Replace the estimates in §3
   with real numbers. _(Read-only, safe to run on the live disk.)_
2. **Decide §7** — tier 2/3/4 or tier 1. It is a league-experience call, not an engineering one.
3. **Build the endpoint** with `dryRun` first. Ship the dry run, look at the diff, then enable the
   write. One PR each.
4. **Archive 2026** after a dry run comes back with a zero totals diff. Then settle the backup
   question separately (§1) — the archive alone does not get the payload under 1 MB.
5. **Then fix it forward** — recommendation **R5** in the review stops the app from writing 85%
   dead rows in the first place, which makes the archive a tidy-up rather than a rescue. Do this
   before the 2027 draft and the 2027 archive is nearly a no-op.
6. **Then consider R11** (splitting `db.json` from `stats-<year>.json`), which makes multi-season
   storage a non-issue rather than a recurring chore.
