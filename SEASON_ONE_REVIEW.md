# Season One QA Review — WMMC 2026

Written 2026-09-01, the day after the season closed. Companion document:
[`OFFSEASON_ARCHIVE_PLAN.md`](OFFSEASON_ARCHIVE_PLAN.md), which covers the data freeze.

---

## How this review was done

Four passes, all against `main` at `fedf029`:

1. **The record.** All 98 entries in `MEMORY.md` + `MEMORY-ARCHIVE.md`, plus `DATA_REPAIRS.md`,
   `SAVE_HARDENING_PLAN.md` and `ROSTER_OPS_PLAN.md`. Every entry is a real incident or decision
   with an outcome attached, which makes it the best available bug corpus for the season.
2. **The code.** `server.js` (20,467 lines), `app.js` (18,670), `js/` (5,434) — read for the
   scoring path, the swap lifecycle, the storage model, the auth surface and the scheduler.
3. **Live checks.** Test suite run (640 pass, 1.8s); mirror-drift audit across every duplicated
   `server.js` ↔ `js/` pair including the unguarded ones; a season-scale storage benchmark.
4. **Measurement.** `scripts/season-storage-report.js` (new, read-only) so the storage numbers
   below can be replaced with the production ones.

**What this review does not cover:** CSS and mobile layout, the Slack copy itself, the roast
prompt quality, and `js/hypothetical.js` beyond its data dependencies. Those are the parts with
the fewest incidents attached to them, and the season's evidence points elsewhere.

---

## The verdict

**The app did its job.** A 16-week, five-period season with a live bracket, daily Slack, MLB
stat syncing and playoff odds ran to completion and crowned a champion, and the podium it
crowned is the right one. That is not a small thing for a first season.

**One structural weakness produced most of the pain, and it is fixable.** _Who was rostered,
when_ is stored in four places that must agree — `roster_dates`, `sd.rosters`, the `manager`
field on every stat row, and `player_dates` — and computed by unioning five heuristics at read
time. Every writer has to update all four correctly; every reader has to defend against the
possibility that they didn't. By my categorization, **43 of the 98 logged entries (44%)** are
that one problem wearing different clothes.

**The season closed with a live scoring defect that survived on luck.** 31.1 points sat
credited to nobody in the semifinal for twelve days (`MEMORY.md` 2026-08-31). Jamie Rogers won
that game by 25.4. Had it gone the other way, the app would have put the wrong manager in the
Championship. This is the single most important thing on this page.

**The scale model does not survive season two.** One season is ~18–20 MB of `db.json`, ~93% of
which is stat rows for players nobody rostered, and the whole file is re-parsed on every
request. That is already why `render.yaml` carries a `--max-old-space-size=400` workaround for
an OOM crash loop.

---

## 1. What worked

**The core invariant, once it was written down.** Scoring a player only inside his own
`add_date → drop_date` window, period-scoped, is the right model and it held. The proof is
2026-06-08: a stale full-season save wiped `sd.rosters` entirely and **the standings stayed
correct**, because they were derived from the date windows rather than the array. A derived
cache died; the source of truth didn't. Nothing else in the app would have survived that.

**One answer to "who won".** `finalPlacements` reads `computePlayoffPairs(sd, 'Finals')` — the
same function the Slack results block and the bracket card use — and is exposed as
`GET /final-placements`. The podium the roasts were written for and the podium the recap crowned
could not diverge. Compare that with the scoreboard's bracket card, which derives its own pairs
and needs a defensive opponent-name check before it can show an odds percentage. The
single-source pattern is strictly better and should be the template.

**Server-authoritative fields.** Making `score_snapshots`, the daily rows, the odds payloads and
`season_closed` server-owned — restored on every save from the stored season — closed the entire
"a stale browser tab wiped production" class. It is the highest-leverage thing done all season.

**The atomic endpoints.** `POST /submissions`, `POST /swaps`, `POST /swaps/:id/approve|deny|undo`
replaced client-mutate-then-save-everything. The "I approved it and it came back pending" and
"my submission vanished" reports stop dead in the log after 2026-06-06.

**`tests/serverMirrors.test.js`.** Mechanizing the "edit both copies" rule as a text comparison
is a genuinely good idea — cheap, no server code executed, and it caught a real drift (a missing
comment in `makeNormalSampler`) the day it was introduced. 26 pairs are guarded today.

**The guards caught things.** The score-swing guard blocked ≥40-point drops before they reached
Slack. The destructive-save guard turned a dangerous auto-applied swap into a pending review
rather than a rejection. The `officialDate` fix — a July make-up game was being credited to a May
week — is exactly the kind of subtle upstream bug that only careful reading finds.

**640 tests in 1.8 seconds.** The `js/` modularization has real coverage: odds, commentary,
recap, eligibility, corrections, the What If engine, late submissions, seeding, brackets. Tests
now outnumber the lines they test (6,426 vs 5,434). Where the code was extracted, it is solid.

**`MEMORY.md`.** 98 entries, each with mechanism and outcome. This review exists because of it.
Keep doing it.

---

## 2. What we fought all season

You named swaps, and the record agrees — but swaps are the symptom. The disease is that the
answer to _"was this player on this manager's roster on this date?"_ is not stored anywhere. It
is recomputed, differently, in several places.

### 2.1 The same fact is stored four times

| Store                                 | Shape                       | Written by                                  | Authority                      |
| ------------------------------------- | --------------------------- | ------------------------------------------- | ------------------------------ |
| `roster_dates[mgr][weekKey][player]`  | `{add_date, drop_date}`     | submissions, swaps, repairs                 | **source of truth**            |
| `rosters[mgr][weekKey]`               | `{batters:[], pitchers:[]}` | swap apply + `rebuildRosterArraysFromDates` | derived cache                  |
| `manager` on every `weekly_*` row     | a name, or null             | `rebuildWeeklyFromDaily`, current week only | derived cache                  |
| `player_dates[weekKey][type][player]` | add/drop override           | `syncPlayerDatesFromRosterDates`            | derived, with manual overrides |

Three of the four are caches. All four are read by something. The season's bug list is largely
the enumeration of ways they came apart.

### 2.2 `roster_dates` stores a period-wide window once per week

`applySwapToSeason` writes the same `{add_date, drop_date}` into **every week bucket of the
period** (`rdWeekKeys`), and the eligibility scan then reads across all buckets anyway —
`latestAdd`/`latestDrop` iterate `Object.values(mgrDates)` and select purely by date. So the week
key is decorative for eligibility and load-bearing for display, and one fact lives in two to five
places that a writer must keep consistent.

That is precisely what broke on 2026-07-29 (`backfillRosterDatesFromSwaps` clobbering
effective-tomorrow drop dates) and on 2026-08-18 (a swap filed in the `SF|Week 2` bucket with an
`add_date` of Aug 17 cleared the _Finals_ period filter, because the scan selects by date and the
bucket it sits in is not consulted).

### 2.3 Eligibility is a union of five heuristics

`managerWeekSubtotal` (server.js:5876) builds its `eligible` set from:

```
weekRoster[listKey]                    // the array cache
∪ activeByDates                        // latest add > latest drop, period-scoped
∪ Object.keys(weekRosterDates)         // this week's bucket
∪ approvedSwaps where week_key matches // the swap log
   … minus wasDroppedBefore(player)    // a scan of every other week
```

then claims stat rows by a second set of rules (unattributed rows by eligibility; rows attributed
to _another_ manager only when this manager has his own window that week). Every clause was added
to fix a specific reported bug, and each one is individually correct. Together they are not a
definition of eligibility — they are a fixed-point of past incidents. Nothing tells you what the
answer _should_ be, so nothing can tell you when it is wrong.

The contrast is instructive: `managerWeekRosterWindows` (server.js:6157), written for the drift
audit, derives the same answer from `roster_dates` alone in 60 readable lines, with the roster
array as an explicit last-resort fallback. **That function is what the scoring path should be
calling.**

### 2.4 The array cache can only grow

`rebuildRosterArraysFromDates` is purely additive by design — it pushes players into week arrays
and never removes any. `managerWeekSubtotal` seeds eligibility with `...weekRoster[listKey]`.
Therefore **a stale array entry scores even with no date window behind it**, and undoing the swap
that created it does not undo the scoring. That is the closing lesson of the 2026-08-18 entry, and
it is still open: Nick Lodolo had to be removed with `POST /roster-remove` by hand.

### 2.5 Attribution is written once and never repaired

`rebuildWeeklyFromDaily` sets the `manager` field, and it only ever runs for the week being
synced. Once a week closes, its attribution is frozen forever. `recomputeAllWeeklyScores`
recomputes every week's _score_ and never touches `manager`. **There is no operation in the
codebase that re-attributes a closed week.**

That is how the 2026-08-31 incident happened: a bad swap was undone, `roster_dates` and the
arrays came back correctly, and the `manager` field on Cantillo's `SF|Week 2` row stayed stamped
with the wrong manager. `managerWeekSubtotal`'s wrong-owner gate then skipped the row for both
managers. 31.1 points belonged to nobody, on the live scoreboard, for twelve days, through the
round that decided the Championship pairing.

### 2.6 …and the audit built to catch exactly that went quiet

`auditWeeklyRollupDrift` does sweep all 16 weeks and is exactly the right check. But
`alertOnRollupDrift` de-duplicates on `lastRollupDriftSignature`, **a module-scope variable**:

```js
if (signature !== lastRollupDriftSignature) { … await postSlack(…) }
```

A drift whose signature does not change posts **once** and is then silent forever (until the
process restarts). A persistent defect is the case that most needs escalation and is the exact
case this silences. Nothing is persisted either, so "was this week ever flagged?" is not an
answerable question after the fact.

---

## 3. Findings

Ranked by what they can cost. Every item was verified in the code today.

### S1 — Scoring correctness

| #   | Finding                                                                                                                                                                                                                                                                                                                | Where                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | No re-attribution pass exists. A week's `manager` field is written once, by the sync, and never repaired. Any correction applied after a week closes leaves it permanently mis-attributed — and mis-attributed points are invisible to every guard, because they all compare a total to another total.                 | `rebuildWeeklyFromDaily`, `recomputeAllWeeklyScores` |
| 2   | The drift audit alerts once per signature and keeps no record. A persistent drift goes silent.                                                                                                                                                                                                                         | `alertOnRollupDrift`, server.js:6336                 |
| 3   | The roster-array heal is additive-only, and the array seeds eligibility. A stale entry scores; undoing the swap that created it does not remove it.                                                                                                                                                                    | `rebuildRosterArraysFromDates`, server.js:6500       |
| 4   | Eligibility has no single definition. Five unioned sources in `managerWeekSubtotal` vs. a clean 60-line derivation in `managerWeekRosterWindows`, which is used only by the audit.                                                                                                                                     | server.js:5876 vs 6157                               |
| 5   | `roster_dates` denormalizes one period-wide window across every week bucket, then ignores the bucket when reading. Writers must keep N copies in step.                                                                                                                                                                 | `applySwapToSeason`, server.js:2339                  |
| 6   | `resync-dryrun` compares `weekly_score` only, so a row whose **owner** changed and whose score did not is absent from the diff — the exact row that mattered on 8/31. (`js/corrections.js` fixed the sweep's classification; the dry-run endpoint still can't see an owner-only move, and still can't see a deletion.) | server.js:10692                                      |

### S2 — Scale, cost and availability

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 7   | Stat rows are stored for **every MLB player in every game**, not just rostered ones. `performMLBSync` iterates the whole boxscore and pushes a row per player per game; `rebuildWeeklyFromDaily` then writes a weekly row per player per week with `manager: null`. ~93% of stored rows belong to players nobody rostered.                                                                              | server.js:11365, 11450, 4183 |
| 8   | `readDB()` does a full `readFileSync` + `JSON.parse` on **every request**, and authenticated requests pay it **twice** (`loadManagerFromHeaders` reads it, then the handler reads it again). Measured on a 19.8 MB season-scale file: 272 ms to parse, 45 MB of heap per parsed copy, 402 ms to re-serialize on every write, 183 MB peak RSS for one parse+write cycle — against a 400 MB heap ceiling. | benchmark, `render.yaml`     |
| 9   | The daily-row sync is O(n²): `sd.daily_batting = sd.daily_batting.filter(…)` runs **inside the per-player, per-game loop**, rebuilding a 35k-row array once per player per game.                                                                                                                                                                                                                        | server.js:11400, 11453       |
| 10  | `GET /api/seasons/:year/daily-stats` returns the entire daily corpus (~15 MB), **unauthenticated**, and GET is **not rate-limited** (`RATE_LIMITED_METHODS` is POST/PUT/PATCH/DELETE only). One loop knocks the instance over and bills the bandwidth.                                                                                                                                                  | server.js:15208, 245         |
| 11  | The Upstash backup is structurally incomplete: `slimForBackup` must strip the daily rows to fit the ~1 MB limit, so disaster recovery restores standings but loses the per-game history the weekly rollups derive from.                                                                                                                                                                                 | server.js:391                |
| 12  | Nothing prunes. Season two lands on top of season one in the same file, parsed on every request. `score_snapshots` (21), `audit_log` (500) and `upload_log` (50) are capped; the stat arrays are not.                                                                                                                                                                                                   | —                            |
| 13  | The swap endpoint deep-clones the whole season (`JSON.parse(JSON.stringify(sd))`, ~45 MB) and runs two full `captureScoreSnapshot` passes, each of which filters the 35k-row daily array once per player per week per manager.                                                                                                                                                                          | server.js:1980               |

### S3 — Security

| #   | Finding                                                                                                                                                                                                                                                                                                                                                 | Where                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 14  | Passwords are stored and compared in plaintext, and `LOGIN_PASSWORD` defaults to a value committed in the source (`'Welcome2Hell'`). Any environment that boots without the env var set — staging, a restore, a new service — is open with a password that is in the repo.                                                                              | server.js:15              |
| 15  | A manager who has not set a personal password authenticates with the shared `LOGIN_PASSWORD`, so **anyone who knows it can log in as them, and can change their password** via the unauthenticated `POST /api/managers/:email/change-password`. `GET /api/managers` publishes the target list — every email, plus `hasCustomPassword`, unauthenticated. | server.js:877, 3292, 3370 |
| 16  | `express.static(__dirname)` serves the repo root. `DB_FILE` defaults to `__dirname/db.json`, and staging deliberately sets no `DB_PATH` — so on staging **`GET /db.json` serves the database, plaintext passwords included**. `managers_seed.json`, `MEMORY.md`, `server.js` and `app.js` are publicly downloadable on both services.                   | server.js:11, 342         |

### S4 — Structure and coverage

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 17  | **No test executes a line of `server.js` or `app.js`.** All 640 tests import from `js/` only; `serverMirrors` reads `server.js` as text. That leaves 39,137 of 44,571 lines untested — including `managerWeekSubtotal`, which computed the season's standings, and `applySwapToSeason`, which wrote them.                                                                                                                                                                                                                      | `tests/*.test.js`                   |
| 18  | The two copies of the scoring function have **structurally diverged**: `js/scoring.js` is table-driven (`for (const [field,key] of Object.entries(BATTING_STAT_KEYS))`), `server.js` hardcodes eight lines. Values match today — I verified `SCORING` and `SEASON_SCHEDULE` are identical — but adding a stat category now updates the client silently and the server not at all. Neither is mirror-guarded.                                                                                                                   | drift audit, today                  |
| 19  | Unguarded mirrors: `SCORING`, `SEASON_SCHEDULE`, `detectScoreSwings`, `checkSwapLimit`, `periodStartForRound`, `managerWeekWindow`↔`managerWeekWindowServer`, `oddsWindowForDate`. All in sync today. `CLAUDE.md` is also stale here — it says `gameFactor` differs by clamp name; it no longer does, and `computeTeamQualityFactors` is the only one that still does.                                                                                                                                                         | drift audit, today                  |
| 20  | Of 93 API routes, **26 exist because the data model needed field surgery** — 15 mutating repair endpoints (`rebuild-roster-arrays`, `reconstruct-rosters`, `purge-orphan-boundary-rosters`, `reseed-approved-boundary-rosters`, `reconcile-boundary-rosters`, `roster-fix`, `rebuild-weeklies`, `apply-corrections`, `backfill`, `backfill-unscored`, `recompute-scores`, `roster-remove`, and three deletes) and 11 read-only diagnostics. All are live, commissioner-callable, and mostly undocumented outside `RUNBOOK.md`. | endpoint census                     |
| 21  | Asset cache-busting is broken. The pre-push hook stamps 8-char git hashes (`app.js?v=b9eb2308`), but `server.js` rewrites with `/\?v=\d+/g` — digits only. `app.js` and `mobile.css` (hashes starting with a letter) are **never rewritten**; `styles.css?v=54461f12` becomes `?v=<timestamp>f12`, mangled. Verified by running the regex.                                                                                                                                                                                     | server.js:335, `.githooks/pre-push` |
| 22  | `scripts/` is outside the lint surface — `npm run lint` covers `server.js app.js js/` only, and every file in `scripts/` fails `eslint` on `no-undef` for `require`/`console`/`process`.                                                                                                                                                                                                                                                                                                                                       | `package.json`, `eslint.config.js`  |

---

## 4. Recommendations for season two

Ordered so that each one makes the next one easier. Effort is rough; risk is what a bad version
of the change could cost.

### Do these before the 2027 draft

**R1. One derivation of eligibility. (high effort, high risk, highest value)**
Promote `managerWeekRosterWindows` to _the_ answer and make `managerWeekSubtotal` a thin
consumer of it: windows in, points out. Keep the five heuristics only as a **shadow comparison**
during a burn-in — run both, log every disagreement, ship the switch when the log is empty for a
week. Vet with a before/after per-manager totals comparison per `SAVE_HARDENING_PLAN.md` §7. Do
this on the frozen 2026 data, where the right answer is already known.

**R2. Stop trusting the `manager` field for scoring. (medium effort, medium risk)**
It is a display and search convenience. Once R1 lands, no scoring path should read it — which
retroactively neutralizes the 8/31 incident class entirely. In the meantime, ship the cheap half
now: a `reattributeWeeklyRows(sd)` pass that recomputes `manager` for **every** week from
`findManagerForPlayerWeek`, wired into `POST /recompute-scores`. That is a few hours and it means
a post-hoc repair can be applied.

**R3. Make the drift audit escalate instead of falling silent. (low effort, low risk)**
Persist findings to a bounded `sd.rollup_drift` the way `sd.correction_flags` already works; keep
re-posting a finding that is _older_ than N days rather than suppressing it; and gate
`/finalize-season` and `/close` on outstanding drift, exactly as they now gate on refused
corrections. This one change would have caught 8/31 on day two, and it is the smallest item on
this page.

**R4. Teach the roster-array heal to prune. (medium effort, medium risk)**
Named as an open follow-up in `MEMORY.md` 2026-08-18 and deliberately deferred from PR #442.
Make `rebuildRosterArraysFromDates` compute the full active set and _replace_ each week's array
rather than appending to it — `reconstructRostersFromSurvivingData` already proves the reset shape
is correct and idempotent. Needs its own before/after totals vet because it moves every manager's
arrays.

**R5. Store only what someone rostered. (medium effort, low risk)**
Filter both sync paths to players in `getRosteredNames(sd)` ∪ this season's pool of actually-held
players before writing daily and weekly rows. This is the single change that fixes findings 7, 8,
9, 11, 12 and 13 at once, and it is _forward-looking_ — it does not touch 2026. Keep the full pool
for the swap-form autocomplete (`batters_pool` is names only, ~30 KB); it is the stat rows that
are 93% dead weight. Note the one real cost: the What If sandbox can only score players who were
rostered. Decide that explicitly. (See `OFFSEASON_ARCHIVE_PLAN.md` §7 for the same trade-off.)

### Do these when convenient

**R6. Fix the auth findings. (low effort, low risk)** All three are small and none need a new
dependency: hash passwords with `crypto.scryptSync` (already imported); make `LOGIN_PASSWORD`
required rather than defaulted, and fail to boot without it; put `requireAuth` on
`GET /api/managers`, `GET /api/seasons` and `GET /api/seasons/:year/daily-stats`; rate-limit GET;
and either move `DB_FILE`'s default outside `__dirname` or serve static files from an explicit
allowlist instead of the repo root.

**R7. Cache the parsed database. (low effort, medium risk)** `dbFingerprint()` and
`dbWriteCounter` already exist for `seasonsPayload` — extend the same idea to `readDB()` for
read-only paths. At 272 ms of parse per request, twice on authenticated ones, this is the largest
single latency win available. The risk is a handler that mutates the cached object without
writing; scope it to GET handlers first, or hand mutating handlers a fresh parse.

**R8. Guard the remaining mirrors, and split what has diverged. (low effort, low risk)**
Add `SCORING`, `SEASON_SCHEDULE` (round/week only), `detectScoreSwings`, `checkSwapLimit` and
`periodStartForRound` to `tests/serverMirrors.test.js`. For the two scoring functions, either
re-sync `server.js` to the table-driven form or extract the table into a JSON file both read —
one source, no mirror. Update the `CLAUDE.md` note about `gameFactor`, which is stale.

**R9. Retire the repair endpoints, on a schedule. (medium effort, medium risk)** They were built
for a data model that was coming apart; if R1–R4 land, most of them are dead. Rather than a
deletion audit that concludes "keep everything" (2026-08-06), give each one an expiry: if it is
not called during the 2027 season, delete it at close. Start by logging every call.

**R10. Fix the cache-bust regex and lint `scripts/`. (trivial)** Delete the runtime `?v=` rewrite
in `server.js` — the pre-push hook's content hashes already do the job properly, and the rewrite
now only corrupts them. Add a `scripts/**` block with Node globals to `eslint.config.js` and
include it in `npm run lint`.

### Consider

**R11. Split the store.** `db.json` holds league state (small, hot, written constantly) and stat
history (large, cold, append-only). Splitting them — `db.json` plus `stats-<year>.json` loaded
lazily — is the structural fix behind R5 and R7, and it is what makes multi-season storage a
non-issue rather than a recurring chore. Bigger than one PR; worth scoping in the offseason.

**R12. Put a test around the scoring path.** Not "test `server.js`" — extract
`managerWeekRosterWindows` + the subtotal into `js/rosterWindows.js` as part of R1, mirror it back,
and unit-test it against fixtures built from the 2026 season's real incidents: the mid-week
handover, the effective-tomorrow add, the period-boundary leak, the undone swap. Each of those is
a bug that shipped; each should be a test that fails without its fix. That converts the season's
pain into permanent coverage, and it is the highest-value use of the frozen 2026 data.

---

## Appendix — checks run today

- `npm test` — 640 pass, 142 suites, 0 fail, 1.8s.
- `npm run lint` / `npm run format:check` — clean.
- **Mirror drift audit** across every `server.js` ↔ `js/` pair, guarded and unguarded:
  `SCORING`, `SEASON_SCHEDULE` (round/week), `ROUND_LABELS`, `PARK_FACTORS`, `APPEARANCE_PRIORS`,
  `ODDS_WINDOW`, `SLACK_EMOJI`, `detectScoreSwings`, `checkSwapLimit`, `oddsWindowForDate`,
  `gameFactor` — **all in sync**. Intentional signature differences (not drift) in
  `periodStartForRound`, `calculateBattingScore`, `calculatePitchingScore`,
  `computeTeamQualityFactors` — see finding 18.
- **Storage benchmark** on a synthesized 19.8 MB season-scale `db.json`: 272 ms parse, 45 MB heap
  per copy, 402 ms serialize, 183 MB peak RSS.
- **Endpoint census**: 93 API routes; 24 unauthenticated; 26 diagnostic or repair.
- **Cache-bust regex**: reproduced the mangling and the two silent misses.
