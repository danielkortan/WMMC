# WMMC — Decisions Log

## Swap approve/undo skipped the date-window recompute — phantom +57 + guard-block loop (2026-07-05)

**Symptom (commissioner).** Approving Chris Bentivegna's IL swap (Julio Rodríguez → Michael
Harris II, drop 07-05, add 07-06 = tomorrow) looked fine, but Slack streamed repeated
":no_entry: Blocked a destructive season save — likely a stale browser tab … Chris drops 57
(2563.2 → 2506.2)" alerts, an undo attempt hit the crater guard ("drops 57 … re-run with
force"), and even freshly-reloaded clients kept 409-ing their render-time auto-saves. Harris
not showing on the roster yet was the one NON-bug: his add date was tomorrow, by design.

**Root cause.** The atomic approve endpoint (#275) ported the client mutation (roster arrays +
`roster_dates` windows + `assignUnclaimedStatsServer`) but NOT the derived-state pass the
full-season save path runs (`syncPlayerDatesFromRosterDates` + `recomputeMidWeekAddScores` +
`rebuildRosterArraysFromDates`). So Harris's already-synced Week-4 weekly row (57 pts) counted
for Chris **immediately, before his 07-06 add date** — no `player_dates` cutoff existed to clip
it, and he was in the week's eligible set three ways (array entry, `roster_dates` entry,
approved swap). The server total inflated to 2563.2; every client computing the CORRECT 2506.2
then read as a ≥40-pt destructive drop and was blocked. **Inversion gotcha: the "stale browser
tab" saves the guard blocked were carrying the RIGHT totals — the server itself held the bad
state.** The undo crater check measured the same phantom 57 and demanded force for what should
have been net-zero.

**Fix (PR #340).** Approve and undo now run the rebuild + resync + recompute pass right after
their mutations, BEFORE their integrity/crater checks: a swap-in scores only within
`add_date → drop_date` from the moment of approval (no dependency on a later sync), the guards
vet the true resulting totals, and the array heal carries the swap-in into later weeks' arrays
(fixes next week's array missing him until an unrelated save). Vetted per SAVE_HARDENING_PLAN
§7 on a seeded temp-DB server (real 2026 schedule, incident shape): effective-tomorrow approval
is score-neutral; a backdated add credits exactly the in-window daily points; undo restores the
original totals (and still correctly demands force only for a legitimate ≥40-pt revert).

**Operational remedy for an already-inflated season** (the code fix does not retro-heal):
`wmmc.forceSync()` — re-derives cutoffs, recompiles, forces past the swing guard. Without it,
every subsequent compile (incl. the 4am daily) reads the correction as a ≥40 drop and gets
blocked daily — same blocked-compile/stale-7am-post signature as the 2026-06-07 Herrera ghost.

**Diagnosis tells (reusable).** Repeating "Blocked a destructive season save" right after a
swap approval, with freshly-reloaded clients still 409-ing, means suspect the SERVER total is
the inflated one — compare the 4am `wmmc.dates()` trail against the live `/api/diag/manager`
total (they differed by exactly the swap-in's week: 2506.2 vs 2563.2). An undo-blocked
"drops N" where N equals the swap-in's week total = the swap-in is counting before his add date.

## Swap Log filters: chips → dropdowns + mobile layout fix (2026-07-05)

- Replaced the chip-based Manager/Type filters (All/None buttons + one chip per value) in the
  Swap Log — both the public tab and the commissioner panel share `renderSwapLog` — with two
  labeled `<select>` dropdowns defaulting to "All managers" / "All types". The chip grid consumed
  most of a phone screen; single-select covers the real use case. Filter state per container is
  now one string per kind (`''` = All) instead of Sets; `swapLogSetFilter` replaced
  `swapLogToggleFilter`/`swapLogSetAll`.
- Mobile (≤768px): the 7-column swap-log table can't fit a phone — it used to overflow and get
  clipped by `body { overflow-x: hidden }`, hiding Date/Status/Reason AND the expanded detail
  panel's values. Now Date/Status/Reason columns are deliberately hidden there (everything is in
  the click-to-expand detail panel), summary cells wrap (base `.data-table tbody td` is
  `white-space: nowrap` — must be overridden or the table overflows), and `.swap-detail-panel`
  collapses to one column. Consequence: the commissioner's inline reason `<select>` (column 7)
  stays desktop-only — same as before, since that column was already clipped off-screen on phones.
- Follow-up (same day, second PR): `swapDetailHtml` now takes `(s, sd, containerId, editable)` and
  renders the Reason row as a `.swap-detail-reason` dropdown when editable, so commissioners can
  edit a swap's reason from the click-to-expand panel — the only reachable editor on mobile. The
  public tab still passes `editable=false` explicitly, so it stays read-only even for a logged-in
  commissioner (matching the pre-existing column behavior).

## Season Stats tab: accolades + merged Trends (2026-07-02)

Renamed the Weekly Scores tab to **Season Stats** and made it three stacked blocks: **Season
Accolades** (new), the **Trends** card (moved from its standalone tab, which was removed), then
the Weekly Team Scoring table. Decisions and mechanics:

- **`js/accolades.js` — pure `computeSeasonAccolades()`** (unit-tested, exported to `window` via
  `js/index.js`). Tallies from the daily rows: days each manager finished in the daily top-3 /
  bottom-3, pitcher negative-point days, batter 3+ strikeout days, plus single-day record lists
  (`recordsN`=5 each — follow-up PR same day, per commissioner: top-5 best/worst manager days and
  best/worst player days; worst player days tiebreak on batter strikeouts, mirroring the server's
  `worstPlayerOverall`). Per-day semantics deliberately **mirror the server's
  `computeDailyHighLow`** (Slack "Yesterday's Best & Worst"): `hadGame` nonzero-delta check,
  same-date doubleheader rows aggregate, and the daily top-3/bottom-3 are **disjoint** (bottom
  drawn from the remainder after the top slice — matters on <6-manager playoff days).
- **Rostered players only.** Manager attribution is a caller-supplied `resolveManager(row, type)`;
  app.js resolves `row.manager || buildRosterLookup()` filtered to registered managers — the same
  path the Trends daily charts use. Display-only; scoring untouched.
- **Tab plumbing:** the section keeps `id="weekly"` (localStorage `wmmc_active_tab` compat); a
  legacy saved `'trends'` value is mapped to `'weekly'` on restore. `renderSeasonAccolades()` runs
  from `renderActiveWeekly`/`showHistoricalSeason` (fresh on every init); **`renderTrends()` still
  only runs on tab activation** — Chart.js canvases size to zero inside a hidden section, and
  re-rendering on the 45s poll would stomp chip/mode selections.
- Daily rows come from the on-demand `ensureDailyStats` cache (both accolades and Trends
  re-render once when the fetch lands). Historical seasons have no daily rows → accolades card
  degrades to a "no daily data" note.
- Defaults chosen without commissioner input (asked, no response): rostered-only player
  accolades, all season days counted (incl. playoffs), records box included. Easy to revisit.
- Verified headless (Playwright, local server seeded from the staging fixture + synthetic daily
  rows): accolade tables/records correct, Trends renders inside Season Stats, legacy `'trends'`
  restore lands on Season Stats, historical season degrades, mobile stacks single-column, dark
  mode clean, zero JS errors.

## Scoreboard PP1/PP2 manager-click panels bled into each other (2026-06-19)

**Symptom.** In the active-season Pool Play Scoreboard (`renderActiveScoreboardTabs`), clicking a
manager's name in the PP2 section showed PP1's player breakdown (or vice versa) instead of that
period's own players/stats.

**Root cause (two bugs in `renderPoolSection`/`toggleManagerDetails`, `app.js`).** (1)
`mgrKey` in `renderPoolSection` was derived from the manager name only (`name.replace(...)`),
with no section suffix — so the same manager's PP1 row and PP2 row produced the **same**
`mgr-detail-<mgrKey>` element ID. `document.getElementById` always resolves to the first match in
the DOM (PP1, since it renders first), so a PP2 click toggled/filled PP1's row. (2) Even with
unique IDs, `toggleManagerDetails` always built **every** `BREAKDOWN_PERIODS` entry (PP1, PP2, QF,
SF, Finals) grouped — correct for Pool Play Overall, but it meant a PP1- or PP2-scoped click still
rendered both periods' players.

**Fix.** `mgrKey` in `renderPoolSection` now suffixes the section (`_pp1`/`_pp2`), giving each
period's row a distinct ID. `toggleManagerDetails` gained a third `periodFilter` param
(`'pp1'`/`'pp2'`/`'overall'`/omitted); when set to a single period it filters `BREAKDOWN_PERIODS`
to just that key before building the panel. Wired through every call site: `renderPoolSection`'s
onclick passes `section`, `renderOverallTable` passes `'overall'` explicitly (same as the prior
default — show everything), and `togglePoolManagers`/`toggleAllManagerDetails` forward
`row.dataset.sbPeriod` (already stamped on each detail row) when re-toggling rows programmatically.
Pool Play Overall is unaffected — it still shows both periods grouped, as the report requested.

**Verified headless (Playwright) against a live local server** seeded from
`tests/fixtures/staging-seed.json`: clicking a manager in PP1 showed only "Pool Play 1" with that
period's batters/pitchers/points; clicking the same manager in PP2 showed only "Pool Play 2" with
its own (different) totals; Pool Play Overall still showed both periods stacked for one manager.
Frontend-only (`app.js`); no `SCORING`/`SEASON_SCHEDULE`/server changes.

## Player-name identity: duplicate-name pool keys + roster-fix purge guard (2026-06-10)

Two production symptoms (PR #305): the swap form offered only "Max Muncy (ATH)" — MLB has TWO
players named Max Muncy and `bootstrapPlayerPools` keyed pool entries by fullName, collapsing
them into one bare entry whose team flip-flopped with catalog order — and scoreboard players
("Nicholas Kurtz", "Ronald Acuna Jr.") showed no team because team maps are keyed by MLB
official spellings while roster strings differ in accents/nicknames, and an id-claimed name
only got a team label when it appeared in a synced boxscore.

- **Duplicate catalog fullNames get team-disambiguated pool keys** ("Max Muncy (LAD)" /
  "Max Muncy (ATH)"), each claimed by id in `sd.mlb_ids`. The ambiguous bare entry is retired
  only when nothing references it (rosters/subs/swaps/roster_dates/attributed rows) and it has
  no id claim. If the bare name IS rostered and unclaimed, nothing is auto-claimed — auto-
  claiming would silently redirect the rostered player's future stats (commissioner resolves
  via roster-fix duplicate_review instead).
- **`displayPlayer` (app.js) falls back to a normalized lookup**; `normalizeName` now lives in
  `js/utils.js` and MUST stay identical to the `server.js` copy (same pact as
  `detectScoreSwings`). The fallback refuses to guess when two team-map keys normalize alike
  but disagree on team.
- **Missing-team-label is a diagnostic tell:** the team map gets the WMMC-name key stamped on
  every synced boxscore appearance, so a rostered player with no team label either has no
  `mlb_ids` claim under a non-canonical name (→ stats landing UNATTRIBUTED under the MLB
  spelling — manager losing points; fix via name-fix/roster-fix) or simply hasn't played.
- **`POST /api/mlb/roster-fix` purge guard (follow-up PR):** the unrostered branch used to
  purge EVERY unrostered name — written pre-bootstrap, it would now gut the catalog-seeded
  pool (~thousands of names) and, worse, purge a rename target written seconds earlier (the
  `rostered` set is a pre-pass snapshot). Now purges only genuinely mismatched names: no exact
  catalog fullName, no valid id claim, not a rename target from the same pass. roster-audit
  similarly skips catalog-exact unrostered names.
- **`renamePlayerInSeason` / `purgePlayerFromSeason` / `extractSeasonPlayerNames` now cover
  `period_submissions`** (they only handled `initial_submissions` — a PP2-submitted player's
  submission record kept the old name after a rename).
- **For a wrong-name rostered player (Kurtz case), prefer the targeted rename**
  (`POST /api/mlb/name-fix` with explicit `mappings`) — it merges the roster onto the
  canonical name so existing unattributed rows count immediately. The commissioner-swap
  alternative (drop old name → add canonical name, dated at period start) also works via UI
  but leaves the old name as a dropped roster row and in the pool. NEVER do both: renaming
  after the swap would collapse player_in/player_out to the same name and clobber the
  add-date in `roster_dates`.

## Daily rows off the seasons payload — on-demand fetch + server-authoritative (2026-06-10)

Second slimming pass (after score_snapshots, below): `daily_batting`/`daily_pitching` — the
largest field, growing every game day — no longer ride `GET /api/seasons`.

- **Server:** GET strips daily rows (alongside snapshots). On save, daily rows are now FULLY
  server-authoritative (`sd.daily_* = existingSd.daily_*` — stronger than the weekly key-merge,
  which stays because commissioner CSV edits legitimately update weekly rows by key). This also
  closes the remaining stale-client daily-row regression vector from the 06-08 "scores froze"
  incident: a stale client's old copy of a daily row can never again win a key match. The bulk
  replace preserves daily rows too. Extracted `sendJsonRevalidated(req,res,obj)` (ETag/304/gzip)
  and applied it to both `GET /api/seasons` and the unfiltered `GET /api/seasons/:year/daily-stats`.
- **Client:** new session cache `DAILY_STATS_CACHE` + `ensureDailyStats(year, onLoaded)` in
  app.js. The only two real daily consumers — Trends daily charts (`renderTrends`) and the
  per-week roster date-window helpers (`getEffBatStats`/`getEffPitStats` in `buildPerWeekRoster`)
  — read `getDailyStatsCached(SELECTED_SEASON)` and render immediately (both already degrade to
  weekly totals), then re-render ONCE when the fetch lands. Cache invalidates whenever the
  seasons JSON string changes (a sync writes weekly+daily together), so daily views refetch after
  syncs; the endpoint's ETag makes a false-positive refetch a 304.
- **Why the client repair flows didn't block this after all** (corrects the earlier deferral
  note): the client-side daily/weekly FILTERING in `repairGhostInitialRosterPlayers` and the
  initial-submission reconcile never stuck server-side anyway — the save's mergeStats re-appended
  every omitted row by key. The real purges are the server-side copies (boot/sync) and dedicated
  endpoints. Those client filters remain as guarded no-ops (`if (sd.daily_batting)`).
- **Verified headless (Playwright) against a live local server:** seasons payload daily-free;
  Trends renders charts with exactly 1 daily fetch, no loop; My Roster windowed stats render;
  endpoint-500 probe → graceful weekly fallback, no retry storm; tampered-daily save → server
  copy wins; save round-trip byte-identical (totals cannot move).
- **Gotcha found while fixturing:** an active season with EMPTY `schedule_dates` throws
  `TypeError: reading 'start'` in `renderWeekly` (pre-existing, unrelated to this change).

## GET /api/seasons slimmed + score_snapshots made server-authoritative (2026-06-10)

Follow-up to the localStorage-quota incident (below): shrink the seasons payload and close the
snapshot-clobber vector, with zero score movement.

- **GET /api/seasons now strips `score_snapshots`** from every season. The client never reads it
  (grep-verified: zero references in app.js/js/); it's the score guard's diagnostic trail, written
  only by server-side `recordScoreSnapshot`. One of the largest payload fields (up to 21 days ×
  per-manager × per-week × per-player detail).
- **`score_snapshots` is server-authoritative on save** (SAVE_HARDENING_PLAN.md Layer 2, first
  field done): `POST /api/seasons/:year` always keeps `existingSd.score_snapshots` (mirroring the
  submissions guard), and the bulk `POST /api/seasons` carries each stored season's trail through
  even a forced replace. This closes a REAL pre-existing hole: any full-season save used to
  replace the trail with whatever the client echoed — a stale tab could roll back or wipe the
  baseline the 40-pt swing guard diffs against (blinding it). `computeSeasonRev` doesn't hash
  snapshots, so no \_rev churn.
- **GET /api/seasons got ETag + 304 + gzip** (built-in `zlib`, no new dependency; Express
  compresses nothing by default and Render doesn't either). `Cache-Control: no-cache` = always
  revalidate: an unchanged re-fetch (every tab switch triggers `syncFromServer`) is now a 304 with
  zero body bytes; a changed one is ~10x smaller. ETag = sha1 of the exact body; If-None-Match
  matched via `includes()` (proxies may weaken to `W/"…"`).
- **Verified live against a local server:** snapshot-free save preserves the trail; a stale save
  carrying rolled-back snapshots loses to the server copy; bulk replace preserves; client-visible
  season JSON byte-identical before/after all saves (totals cannot move); 304 + gzip confirmed.
- **Deliberately NOT done — daily-row stripping.** `daily_batting`/`daily_pitching` ARE read
  client-side (Trends daily charts ~app.js:5216, per-player daily views ~7308) and FILTERED by
  client repair flows (`repairGhostInitialRosterPlayers` ~6176, purge flow ~11042) whose results
  ride the full save. Stripping them would silently disable ghost daily-row purging — leftover
  ghost rows resurface into weekly scores on the next `rebuildWeeklyFromDaily`. Score-affecting;
  requires moving those repair flows server-side first.

## Scoreboard differed per device / fresh browser empty — localStorage quota, not HTTP cache (2026-06-10)

**Symptom (commissioner).** Three devices showed three DIFFERENT scoreboards (mobile + Chrome both
stuck on "PP1 Week 5" with different totals; a brand-new Firefox login showed NO data at all —
"No roster data yet"), while the 7am Slack post (server-computed) was correct. Hard refresh did
not help on any device.

**Root cause.** The client cached the entire seasons blob in `localStorage('wmmc_seasons')` and
**rendered from localStorage**. The blob (2025 season + 2026 daily rows + score snapshots) outgrew
the ~5MB per-site localStorage quota, so every `setItem` threw; `loadData`/`syncFromServer` caught
the throw as "server unavailable — using local data" and silently kept whatever vintage each device
last managed to store. Hence: per-device frozen scoreboards (different vintages), an empty fresh
browser (nothing ever stored), hard-refresh immunity (not an HTTP-cache problem), and a correct
Slack post (server-side from db.json). Also: the seasons `setItem` threw BEFORE the managers
`setItem` in the same try block, so managers updates were lost too.

**Fix (`app.js`, client-only).** In-memory JSON-string cache (`SEASONS_JSON`/`MANAGERS_JSON`) is
now the session's source of truth; ALL reads/writes go through `readSeasonsJSON`/`setSeasonsLocal`
(+ managers twins). `getSeasons()` still returns a fresh `JSON.parse` per call (copy semantics
preserved — no aliasing change). localStorage is demoted to a best-effort mirror: on quota failure,
drop the old (stale) mirror and retry once (frees its quota; a stale mirror is worse than none),
else warn and continue — never throw, never abort the caller. Fresh server data therefore always
renders, even when it can't be persisted.

**Diagnosis tells (reusable).** "Different data on different devices + fresh browser empty + hard
refresh doesn't help + Slack/server output correct" = the client-side cache write is failing, not
the server or HTTP caching. The version watcher (`/api/build`) only fixes stale CODE, not stale DATA.

**Open follow-up (not built).** The seasons payload grows daily (~455 daily stat rows/day + up to
21 per-player score snapshots) and is re-downloaded on every tab switch — eventually worth trimming
GET /api/seasons (e.g. omit `score_snapshots`/daily rows from the client payload), but that
interacts with the clobber-prone full-season save (the client POSTs back what it loaded), so it
needs the merge guards audited first.

## Per-round Manager Submission Status (collapsible, auto-open current period) (2026-06-08)

Commissioner "Manager Submission Status" table was PP1-only; now there are multiple submission
periods. Rewrote `renderSubmissionStatusTable` (app.js) to render one section per period (PP1, PP2,
QF, SF, Finals), each a native `<details>`/`<summary>` collapsible. Pool Play sections list all
active managers; **playoff sections list only advancers** via `getQFQualifiers` / `getSFParticipants`
/ `getFinalsParticipants` (a muted "pending finalization" note until the prior round is finalized).
Each summary shows an at-a-glance tally (`N approved · N pending · N not submitted (total)`). The
section auto-expanded is the latest period whose submission window has already opened
(`getPeriodOpenDate <= now`) and has participants — i.e. the round currently in play (PP2 now, QF
when its window opens, etc.). Styling is theme-aware (`.sub-status-period` in styles.css, using
`var(--border)`/`var(--card-bg)`/`var(--text-muted)`). Frontend-only; no server/SCORING changes.

## reconcile-boundary-rosters endpoint — prune array-only orphans from a backed roster (2026-06-08)

**Symptom.** After fixing Joey's approval, the stale-extras probe still flagged Taj Bradley. The
roster editor / My-Roster view showed his correct 3 pitchers, but the raw `rosters['Joey']['PP2|
Week 1'].pitchers` array held a 4th (Bradley) with NO matching `roster_dates` entry — an array-only
orphan that resurfaced (a stale pre-#291 client re-added it via carry-forward; non-empty client
array wins the save). The purge endpoint only clears managers with NO roster_dates (Joey has a real
roster); reseed only acts on managers with no period roster_dates — so neither removes a single
stray extra from an otherwise-backed roster.

**Fix.** New `POST /api/seasons/:year/reconcile-boundary-rosters[?dryRun=1]` (commissioner,
re-runnable). For each STARTED period-boundary week (PP2/QF/SF/Finals Week 1), for each manager who
already has a roster_dates-backed roster there, prune any array player NOT present in that week's
`roster_dates` (+ their zero-stat weekly rows). Boundary weeks ONLY — mid-period weeks legitimately
hold carried-forward players whose roster_dates live under an earlier week, so they're never
touched. Skips played weeks; score-neutral (orphans have 0 pts while unplayed); dry-run + before/
after totals. This is the precise tool for "a backed roster picked up a stray extra"; purge =
whole-week no-submission orphans, reseed = approved-but-unwritten roster, reconcile = prune extras.

**Recurrence note:** array-only orphans keep resurfacing while any manager runs pre-#291 client code
(their carry-forward re-save re-adds the holdover). reconcile is the mop-up; the recurrence ends as
clients reload onto the boundary-aware client (version.json forces it on next visit).

## Approval conflict check + roster write read/wrote the array, not authoritative sources (2026-06-08)

**Symptoms (commissioner).** (1) After clearing orphans, the false "Yamamoto already on Edgar's
roster" block RETURNED — Edgar's PP2 Week-1 ARRAY held Yamamoto again (`roster_dates=false`,
`submission=false`): a carry-forward orphan resurrected (a stale-code client re-saved it; non-empty
client array wins over the server's cleared one). The period-scoped check (PR #293) was loaded and
working, but it reads the raw array, so the bogus entry still blocked. (2) Joey's PP2 Week 1 showed
a 5th batter (Jonathan Aranda) — a resurrected carry-forward; approval **appended** his 4 submitted
batters to the polluted array instead of replacing it.

**Root cause.** The roster ARRAY is a derived cache that can hold stale carry-forward/orphan
entries. Both the duplicate-roster check and the approval roster-write trusted it.

**Fix (`app.js`, client-only — PR).**

- New `playersClaimedByOthers(sd, period, roundKey, excludeManager)`: builds the "taken by another
  manager" set from **approved submissions + period-scoped roster_dates** (honoring drops via latest
  add/drop), NOT the arrays. Used by both `approvePeriodSubmission` and `approveInitialSubmission`.
  An orphan array entry with no submission/roster_dates behind it can no longer cause a false block.
- `approvePeriodSubmission` now **replaces** the period Week-1 array + roster_dates with EXACTLY the
  submission (was append) — so a stale carry-forward player is dropped on approval, not kept as an
  extra slot. In-period swaps happen after approval and are re-applied from swap records by
  `repairCarryForwardRosters`.

**Existing pollution (e.g. Joey's Aranda):** the replace only fixes FUTURE approvals; an
already-approved manager with a stale extra is fixed by the commissioner roster editor "Remove", or
by re-approving (deny → approve) once deployed. Orphans keep resurfacing while any manager's browser
runs pre-#291 code — durable end-state is everyone on the new client (version.json forces reload).

## "Your view is out of date" 409 on submission approval → submission approved but roster lost (2026-06-08)

**Symptom (commissioner).** Approving a PP2 submission threw the "out of date / not in sync" alert
and reloaded; afterward the manager's PP2 roster was empty AND no "lineup not submitted" warning
showed (so the submission record survived as `approved`, but the roster never got written).

**Root cause.** `approvePeriodSubmission` (1) approves via the atomic `persistSubmission` endpoint —
which bumps the server `_rev` concurrency token and `adoptRev`s the new token into **localStorage**
— then (2) mutates the in-memory `sd` and calls `saveSeason(year, sd)` to write the roster. But
`sd._rev` was still the OLD token (`adoptRev` updated only the localStorage copy, not the live `sd`
reference), so `saveSeason` posted a stale token → server **409** → alert + reload. The submission
was already flipped to `approved`, but the roster's full-season save was rejected and lost. Same
"approval roster side-effect rides the clobber-prone full save" fragility that clobbered Chris/
Austin earlier — here triggered by the stale token (and worsened because out-of-band server writes
this session, e.g. purge/reseed, advanced the server `_rev` while the page stayed open).

**Fix (`app.js`, client-only).** In `saveSeason`, before posting, reconcile `data._rev` to the
freshest token in localStorage (`getSeasons()[year]._rev`), which `adoptRev`/load/save-success keep
current. So any atomic-call-then-full-save sequence (submission approve, swap approve) stops falsely
409-ing. localStorage holds only tokens THIS client legitimately obtained, so staleness protection
against other writers is preserved; the server Layer-3 integrity guard remains the backstop.

**Recovery for already-stuck approvals:** run `reseed-approved-boundary-rosters` — it writes the
roster + roster_dates from the `approved` submission for any manager missing period roster_dates.

## Submission-approval duplicate check wasn't period-scoped → false "already on another roster" (2026-06-08)

**Symptom (commissioner).** Approving Joey Auclair's PP2 submission errored "Yamamoto is already
on another player's roster (Edgar)", but Edgar had no PP2 submission — Yamamoto was only on Edgar's
PP1 roster (before an in-PP1 trade). A fresh PP2 draft should make him available.

**Root cause.** `approvePeriodSubmission` (and `approveInitialSubmission`) built the
"rostered by another manager" set by scanning **every week of every other manager's roster arrays
with no period scoping** (`for (const wRoster of Object.values(mgrRoster))`). So any PP1 holdover
blocked a PP2 submission — i.e. no player another manager _ever_ rostered in PP1 could be drafted
in PP2. Same period-leak family as the carry-forward bug.

**Fix (`app.js`, client-only — approval is client-driven).** Scope both duplicate checks to the
submission's own period: skip week keys whose round (`wKey.split('|')[0]`) isn't the period being
approved (`PP2` for Joey; `PP1` for the initial path). Only a player on another manager's
SAME-period roster is a real conflict. Hoisted `roundKey` above the check in
`approvePeriodSubmission` (removed the later duplicate declaration). No server twin.

## Carry-forward repair leaked across period boundaries → orphan PP2 Week-1 rosters (2026-06-08)

**Symptom (commissioner).** Cam McCallum, Anton Capria, Alex Thalacker (and others) saw the
"Your Pool Play 2 lineup is not submitted" banner even though the Commissioner Roster editor
showed a full PP2 Week-1 roster. A prior unexpected auto-advance was suspected (and its markers
had been cleared), yet the rosters persisted.

**Diagnosis (read-only console probe on live).** PP2 Week 1 (idx 5) was NOT in
`auto_advanced_weeks`/`advanced_weeks`, but **all 12** managers had exactly 7 players in the
`PP2|Week 1` array. Only Daniel Kortan had `roster_dates` for that week (real approved
submission); 9 managers had a NONE submission + 0 `roster_dates` (orphan carry-forward); Chris
Bentivegna / Austin Johnson had approved subs but 0 `roster_dates` (array possibly stale vs
submission — flagged, not touched).

**Root cause.** The "lineup not submitted" banner (`app.js` `updateSubmissionWarningBanner`) keys
off `period_submissions.pp2[mgr]` status only — it ignores the roster. So a roster with no
submission backing still triggers it. The roster itself came from **`repairCarryForwardRosters`**
(server.js + app.js), the one carry-forward path the 2026-06-08 period-aware fix missed: it
rebuilt an empty non-future, non-trusted week from the prior week's carry-forward **without
skipping period (round) boundaries**, so it re-filled `PP2|Week 1` from `PP1|Week 5` every
boot/render. The stripped auto-advance markers couldn't stop it. (`activeByDates`,
`rebuildRosterArraysFromDates`, and the Sunday auto-advance were already boundary-aware; this
array repair was not.)

**Fix (this PR).**

- **Durable:** `repairCarryForwardRosters` now resets the carry-forward baseline
  (`prevBatters/prevPitchers = null`) at every period boundary (`SEASON_SCHEDULE[i].round !==
[i-1].round`) in BOTH `server.js` and `app.js`. A boundary week becomes a trusted seed owned by
  its own submission (kept if it has submission data, left empty otherwise) — the prior period
  never carries across. Bumped `ROSTER_REPAIR_VERSION` 6 → 7 (both files) so the recompute pass
  re-runs on deploy.
- **Cleanup:** new `POST /api/seasons/:year/purge-orphan-boundary-rosters[?dryRun=1]`
  (commissioner). For each started boundary week, clears the array + `roster_dates` + zero-stat
  weekly rows for managers with NO pending/approved submission for that period; leaves
  submission-backed managers untouched; skips any week with real points. Returns
  `cleared`/`kept`/`skipped` + a before/after per-manager total check (must be score-neutral — an
  unplayed boundary week scores 0).

**Run order on deploy:** ship the code → hard-refresh the commissioner browser (so the OLD client
repair can't re-add the orphans on its next save) → `dryRun` the endpoint → run it for real →
re-run the probe to confirm orphans cleared. **Done on prod 2026-06-08** (PR #291): 9 orphans
cleared, `moved_totals: []`, server dry-run re-confirmed `cleared: []`.

**Follow-up — approved-but-clobbered boundary rosters (PR #2, same day).** Inspecting Chris
Bentivegna confirmed the 0-`roster_dates` case is a real bug, not cosmetic: his PP2 Week-1 ARRAY
held his PP1 carry-forward roster (JJ Wetherholt / Ranger Suárez / Kevin Gausman), NOT his
approved PP2 submission (Byron Buxton / Bryce Miller / Dylan Cease), and his `roster_dates` had
only PP1 keys. Cause: approving a period submission persists the submission record atomically, but
the roster + `roster_dates` side-effect rides the clobber-prone full-season save — Daniel's
landed, Chris's & Austin's were clobbered, leaving the stale PP1 carry-forward in PP2. The
boundary-aware repair (above) preserves but does not CORRECT an already-wrong boundary array, and
the purge endpoint deliberately keeps submission-backed managers — so neither fixes it. Added
`POST /api/seasons/:year/reseed-approved-boundary-rosters[?dryRun=1]`: for each started boundary
week, rewrites the array + `roster_dates` (add_date = period start) from the APPROVED submission
and prunes stale zero-stat rows — but ONLY for managers with no period-dated `roster_dates` and no
approved swap effective in the period, so a legitimate in-period swap is never clobbered. Skips
weeks with real points; score-neutral while the period is unplayed. Must run before the period's
first games count.

## PP2 submission window closed ~a day early — midnight fallback in getPeriodFirstGame (2026-06-08)

**Symptom (managers).** PP2 "Player Submission" card read "Submission window has closed" all day,
even though PP2's first games weren't until ~6:30 PM ET that evening. The window should stay open
until first pitch.

**Root cause.** No explicit `period_deadlines.pp2` was stored, so `getPeriodFirstGame` (app.js)
fell back to `new Date(dates[idx].start + 'T00:00:00')` — **midnight at the start** of PP2's first
day. The deadline is first game − 5 min, i.e. **23:55 the night before**, so the window closed
~18 h before games actually started. (The window check is client-only — server.js does NOT enforce
the deadline on `POST /submissions`.)

**Fix.** Relocated `PERIOD_DEADLINE_DEFAULTS` (already held a sane evening first-pitch time per
period, e.g. `pp2: 18:35`) up next to the period config, and changed the `getPeriodFirstGame`
fallback to apply that **time-of-day** to the authoritative schedule date instead of midnight.
Explicit `period_deadlines[period]` (commissioner / MLB-API autofill) still wins. So a missing
deadline now closes at a realistic first-pitch time, not the previous midnight. Frontend-only
(`app.js`); no `SCORING`/`SEASON_SCHEDULE`/server changes. Supersedes the 2026-06-06 follow-up
note below that said the fallback uses the Week-1 start (it was midnight = too early).

## `sd.rosters` wiped by a stale full-season save → Best/Worst Slack section vanished, scores froze (2026-06-08)

**Symptom (commissioner).** Morning 7am Slack post showed only the scoreboard, no "Yesterday's
Best & Worst" section, no error. Overnight standings barely moved (9/12 managers unchanged; a few
moved, some players "down ~30") despite a full Sunday (6/07) MLB slate. PP1 W5 → PP2 W1 had just
rolled over.

**Root cause.** `sd.rosters` (the per-week roster ARRAYS) had been wiped to `{}` — almost
certainly a stale full-season `POST /api/seasons/:year` from a background browser tab whose cached
season predated the rosters. The save handler guarded stats/pools/`roster_dates`/`schedule_dates`/
submissions/swaps but **not `rosters`**, and the post-save `rebuildRosterArraysFromDates` heal is
additive-only (augments existing week entries; can't recreate wiped ones).

Why the symptoms diverged:

- **Standings survived** — `computeRoundScores → managerWeekSubtotal` falls back to `roster_dates`
  carry-forward (`activeByDates`), which was intact (12 mgrs). So totals limped along.
- **Best/Worst broke** — `computeDailyHighLow → findManagerForPlayerWeek` reads ONLY the
  `sd.rosters` arrays. Empty arrays → every 6/07 player resolved to no manager → `null` → section
  omitted (silently, no error).
- **"Scores froze / some down 30"** — the same stale save's `mergeStats` let the client's older
  PP1 W5 weekly rows WIN the key match (`round|week|player`), reverting 6/07 scores; the 6/07
  DAILY rows were re-appended by the merge and survived (confirmed: 320 bat / 135 pit for 6/07,
  correctly tagged PP1 Week 5, nonzero deltas).
- **Latent danger** — the next `rebuildWeeklyFromDaily` (4am sync / Rebuild Totals) re-attributes
  through the empty arrays → sets every weekly row `manager:null` → zeroes the board.

**Diagnosis tells.** `findManagerForPlayerWeek` reads arrays; `managerWeekSubtotal` reads
`roster_dates`. When standings look right but daily high/low / Live tab / per-player views are
empty, suspect a `sd.rosters` array problem, not a scoring-engine bug. `rebuild-roster-arrays` is
a NO-OP on a full wipe (additive over existing entries).

**Fix (PR, branch `claude/loving-archimedes-YyKvx`).**

1. **Save guard** in `POST /api/seasons/:year`: preserve the server's roster arrays for any
   manager the incoming payload drops/empties (mirrors the `roster_dates`/`schedule_dates`
   guards). Non-empty client arrays still win, so real add/drop edits propagate.
2. **`reconstructRostersFromSurvivingData(sd)`** + `POST /api/seasons/:year/reconstruct-rosters`:
   rebuilds wiped arrays from scratch — weekly-row `manager` fields (exact, reproduces standings)
   then `roster_dates` carry-forward. Score-neutral; reports any moved totals.
3. **`auditSeasonIntegrity`** now flags an empty `rosters` object while weekly stats exist.

**Recovery runbook (this incident).** `reconstruct-rosters` → then Rebuild Totals (re-rolls weekly
from the surviving 6/07 daily rows with restored attribution; standings move up, Best/Worst
returns) → verify.

**Follow-up — two wrong cuts before the right one (key lesson).** The standings were ALREADY
correct this morning with `rosters === {}` — `managerWeekSubtotal` derives eligibility from
`roster_dates` + swaps (`activeByDates`), so the empty arrays only broke findManagerForPlayerWeek
(Best/Worst, Live tab), not the totals. The wipe-recovery just needs to repopulate the arrays
with each week's **date-windowed** roster, matching that eligibility.

- **Wrong cut 1:** rebuild via `rebuildRosterArraysFromDates` carry-forward over ALL weeks —
  inflated (credited dropped/swapped players for the whole period). Daniel 1,372→1,644.
- **Wrong cut 2:** rebuild scored weeks from the weekly-row `manager` field. That field is
  **sticky** — a dropped/swapped player keeps `manager: X` on later-week rows — so it re-added
  players to weeks they'd left (a PP2-only player in PP1; a Week-3 add scoring in Weeks 1–2) and
  re-inflated. Also non-idempotent.
- **Right cut:** reset → seed an entry per manager × already-started week → `rebuildRosterArraysFromDates`
  to fill them with the date-windowed active set (`roster_dates` + swaps, honoring add/drop). The
  arrays then equal `activeByDates`, so they're a subset of the scoring eligibility set —
  restoring findManagerForPlayerWeek WITHOUT moving any total. Idempotent (full reset each run).

**Lessons:** (1) weekly-row `manager` is NOT swap-honored — never reconstruct rosters from it.
(2) `roster_dates` + swaps (date windows) is the only swap-honored source. (3) populating arrays
with anything BEYOND the date-windowed active set inflates totals, because `managerWeekSubtotal`
counts a manager's stat rows gated on the player being in the week's eligible set (arrays ∪
activeByDates).

**Follow-up — carry-forward was not period-aware (2026-06-08).** After recovery, PP2 Week 1 showed
PP1 holdovers (Sal Stewart, Gavin Williams) that were never in the PP2 submission. Cause:
`activeByDates` (managerWeekSubtotal) and `rebuildRosterArraysFromDates` carried a player forward
globally — a PP1 add with no drop reads as "active" at PP2's date. But PP2/QF/SF/Finals each start
fresh from their own submission (the Sunday auto-advance already skips `isPeriodBoundaryWeek` for
exactly this reason). Fix: new `periodStartForRound(sd, round)` (server + app.js mirror); the
carry-forward now only counts adds/drops dated on/after the week's PERIOD start. Returns null for
PP1 (initial period) so PP1 scoring/rosters are untouched. Also: `reconstruct-rosters` now seeds
each started non-initial period's first week directly from the approved `period_submissions[period]`
(belt-and-suspenders so a kept player is never lost), skipping anyone dropped within the period.
Confirmed PP2 submission players carry explicit `add_date` = period start in `roster_dates`, so the
date heal already includes them; the submission seed is the safety net. Verified live:
reconstruct's `moved_totals` came back `[]` (idempotent, PP1 totals unchanged) and PP2 dropped its
holdovers. Follow-up PR period-scoped the swap-form "current roster" helpers too
(`isStillActiveForMgr`, `isCurrentlyTaken`): they now scope adds/drops to the CURRENT period (the
latest round whose first week has started), so a prior period's holdover no longer appears in
Player Out or out of the available pool. The existing latest-week-array fallback stays correct
because the reconstructed period arrays are clean.

## Scoreboard manager-detail: group players by period + heal arrays so breakdowns reconcile (2026-06-07)

**Symptom (commissioner).** In the scoreboard's per-manager expandable, a swapped-in/never-dropped
player (Juan Soto, added 5/22) showed greyed in his add week and was missing from later weeks, and
the whole current roster showed "6/08–" tags. Two distinct things were conflated:

- **"6/08–" tags = the PP2 roster submission** (PP2 starts 6/08; submission writes roster*dates
  under PP2 week keys with add 6/08). Confirmed \_not* a scoring bug — `activeByDates` caps
  eligibility at `add_date <= weekEnd`, so a 6/08 add can't leak into PP1 weeks. The merged
  (PP1+PP2) player list just made it look wrong.
- **Soto showing only 19 = a real under-count in the _breakdown_, not the total.** Manager totals
  come from the carry-forward engine (`managerWeekSubtotal` + `activeByDates`) and are correct. The
  per-player breakdown attributed via `playerPts → weeklyRowOwner → buildRosterLookup`, which keys
  off the per-week roster _arrays_. A mid-period swap-in lives in `roster_dates` only under its add
  week's bucket; the later weeks' arrays never got him (carry-forward repair skips already-populated
  weeks unless `ROSTER_REPAIR_VERSION` bumps), so `weeklyRowOwner` returned no owner for those rows.
  Same stale-array root cause as the My-Roster per-week view.

**Fixes (this PR):**

- **Frontend (`app.js`) — `toggleManagerDetails` rewritten to group by scoring period.** Each period
  (PP1 / PP2 / QF / SF / Finals present in `SEASON_SCHEDULE`) is its own collapsible subsection;
  the period whose date window contains today is auto-expanded (`PP1` today, `PP2` once 6/08
  arrives), others collapsed. Per-player points now come from `managerWeekSubtotal` with a new
  `detailOut` param (added to the client copy, mirroring server.js), summed across the period's
  weeks — so the rows reconcile to the period subtotal and a carried-forward swap-in scores every
  eligible week. Date tags are clipped to each period's window (`periodPlayerTag`), so a PP2 6/08
  add never renders inside the PP1 subsection. Removed the old `playerPts`/`playerHistory`/
  `buildPlayerRows` helpers. New `window.toggleSbmdPeriod`; styles under `.sbmd-*` in styles.css.
- **`managerWeekSubtotal` (client) gained `detailOut`** — pushes `{player, score}` for every
  eligible player _of that type_ (type-restricted via the week's roster array since the eligibility
  set is type-agnostic); scores still sum to the returned subtotal (array-only/0-stat players
  contribute 0). Server copy already had `detailOut`.
- **Server (`server.js`) — auto-heal roster arrays from roster_dates.** Added
  `rebuildRosterArraysFromDates(sd)` to (a) the full-season save handler (active seasons), so every
  swap/submission approval keeps arrays in sync, and (b) startup after `repairCarryForwardRosters`,
  so the deploy heals existing data. Additive + idempotent + **score-neutral** (the engine already
  counts these players via `activeByDates`), so totals never move and the guard can't fire. This is
  the "durable fix" — it stops the per-player breakdowns (scoreboard _and_ My Roster) from
  under-counting after an in-season swap, instead of relying on the manual
  `POST /api/seasons/:year/rebuild-roster-arrays` one-shot.

**Gotcha reinforced:** per-player _display_ paths historically read roster _arrays_
(`weeklyRowOwner` / `onRoster`), while _scoring_ reads `roster_dates` carry-forward. Keeping the
arrays healed from roster_dates is what makes the two agree.

## Ghost player caused recurring 4am score-guard block — Joey Auclair / Iván Herrera (2026-06-07)

**Symptom.** Every morning the guard BLOCKED the 4am compile (Joey ~−177), the 7am Slack post
didn't match the live scoreboard, and the snapshot trail was empty (`wmmc.dates()` → 0). The
Sunday 6am auto-advance also posted a misleading "advanced 12 rosters to PP2 Week 1".

**Root cause.** **Iván Herrera** was credited to Joey across PP1 Wk1–5 (~207 pts) via stat
records + a `roster_dates` add-date, but was never in his submission, any weekly roster, or any
approved swap. The server's `managerWeekSubtotal` credits a player who has a `roster_dates` add
(and isn't dropped) via **carry-forward eligibility**, even when the `rosters[week]` array omits
them — so server paths (score-guard snapshot, server scoreboard, `/api/diag/manager`) counted
Herrera (~1,549) while the **client** scoreboard's stricter array check excluded him (~1,342).
That mismatch is the "two different scores." The 4am compile tried to land the correct ~1,372
(ghost gone + real games), which read as a >40-pt drop → blocked → nothing saved → no snapshot →
empty trail → stale 7am post → re-blocked daily.

**Gotchas to remember:**

- `roster_dates` is **sticky**: the roster-save endpoint (`server.js` ~588) re-appends any
  server-side entry the client omits, so a ghost add-date must be purged server-side.
- `managerWeekSubtotal` credits via `roster_dates` carry-forward, not just the rosters array —
  that's the path a ghost rides to score. Purges must remove `roster_dates`/`player_dates`, not
  just stat rows.
- `repairGhostInitialRosterPlayers` only cleans **Week 1** (can't catch a multi-week ghost); it
  now matches the pool via `normalizeName` (an accented name like "Iván" slipped the old
  exact-string filter).
- The snapshot trail is written only by a **non-blocked** compile, so blocked mornings leave it
  empty and `wmmc.diff()` useless — fall back to `wmmc.mgr("<name>")`.

**Fixes (PR #261, merged → prod 2026-06-07):** `purgeGhostHerreraFromJoey` and
`purgeBoundaryAutoAdvance` (gated one-time repairs); boundary-aware auto-advance
(`isPeriodBoundaryWeek` — silent at PP1→PP2/PP2→QF/QF→SF/SF→Finals, runs mid-period);
`POST /api/mlb/snapshot` (+ `wmmc.snapshot()`); `GET /api/mlb/ghost-audit` (+ `wmmc.ghosts()`,
read-only). SCOREFIX is now walked through **inline in chat**, not by pointing at RUNBOOK
(codified in `CLAUDE.md`).

**Recovery procedure (reusable):** identify (`wmmc.mgr` / `wmmc.ghosts`) → confirm with
commissioner the player was never rostered → purge server-side incl. `roster_dates`/`player_dates`
→ deploy, confirm `[Ghost purge]` log → `wmmc.forceSync()` (applies dropped games + records
baseline) → `wmmc.dates()` to confirm the seeded baseline. Verified: Joey settled at 1,372.45
(== the guard's original "after"), `maxDrop 2.6, blockers 0`, trail seeded.

**Open follow-up (not built):** generalized ghost sweep driven by `ghost-audit`, plus a guard on
the sticky `roster_dates` re-append so it won't resurrect an originless entry.

## Roster-date display hardening + duplicate repair-swap dedup (2026-06-07)

Commissioner flagged odd roster displays. Diagnosed from `/api/diag/manager`:

- **"Missing stats" (Juan Soto on Daniel Kortan)** was NOT a scoring bug — the engine credits
  Soto 19+72+13=104 across PP1 Wk3–5 and the Overall total already includes it. The **My Roster
  per-player view** read **stale roster arrays** (Wk3–5 still listed Yordan Alvarez, never updated
  when Soto was swapped in 5/22 — scoring runs off `roster_dates`, not arrays), so Soto's line
  only showed his first week. Fix = run the existing **`POST /api/seasons/:year/rebuild-roster-arrays`**
  (additive; totals don't move). No code needed.
- **"Backwards date" (Ryan Weathers)** = an intentional pre-season drop (drop_date 2026-04-29,
  before the 5/04 season start; made before the submission-edit feature existed). His 0 is correct;
  only the display was wrong. Hardened `notRosteredTag` (app.js): a drop earlier than the add, or a
  drop before the season start with no add, no longer renders as a backwards range (shows
  "not rostered").
- **Duplicate `repair-` swaps:** a league-wide scan found 7 `repair-…` swaps (artifacts of the
  deleted Phase-3 band-aids), 3 of which **duplicate a real swap** (Daniel/Alvarez→Soto,
  Austin/Walker→Chisholm, Bentivegna/Cease→Suarez). Added **`POST /api/seasons/:year/dedupe-repair-swaps`**
  (commissioner): removes only `repair-` swaps whose (manager, player_out, player_in, week_key)
  matches a non-repair swap; keeps the 4 that are the SOLE record of a move (deleting them would
  erase the move). Idempotent; reports removed + before/after totals (should not move, swap
  application is idempotent — this is hygiene, not a points fix).

## Approving a not-yet-started period's submission was purged by carry-forward repair (2026-06-06)

Staging smoke-test of the atomic-submission PR: approving a PP2 submission marked it approved
but the 7 players never appeared on the manager's PP2 Week 1 roster (no error). Server side was
proven correct (the full-save persists the roster); the culprit is **client-only**
`repairCarryForwardRosters`, which runs on every `renderRosterData` and **purges any future-week
roster (weekStart > today) whose index isn't in `advanced_weeks`** ("speculative future write"
guard). Submission windows open _before_ a round starts, so an approved PP2/QF/SF/Finals roster
(and now PP1, since its window opens early too) is written to a future week and immediately wiped
on the next render.

Fix: in `approvePeriodSubmission` / `approveInitialSubmission`, when the period's Week 1 is still
in the future (`weekStart > todayET`), push that week index into `sd.advanced_weeks` so the purge
treats it as a legitimate write. Surgical — only marks the week when it's actually future
(current/past-week approvals, e.g. PP1 at normal season start, are untouched). Pre-existing latent
bug, exposed by the early submission windows; fixed as part of the submission PR since it blocks
the very flow being shipped.

## Atomic roster-submission endpoints — stop lost/clobbered submissions (2026-06-06)

Commissioner saw a manager's PP2 submission on the manager's device (pending) but not in
their own queue. Root cause: roster submissions (PP1 + PP2/playoff) were written **only**
through the fire-and-forget full-season save (`saveSeason` → background `POST /api/seasons/:year`
with `.catch(()=>{})`). Two failure modes: (1) the POST fails silently on a weak connection →
submission lives in localStorage only; (2) `initial_submissions`/`period_submissions` were **not**
merge-protected on the server, so a stale full-season save from another browser (e.g. the
commissioner working the queue) overwrote a submission someone else just made. Same class of
bug as the lost-swaps fix (#257, `d7286a6`); submissions just never got the same treatment.

Fix mirrors the swap fix:

- **Server:** `POST /api/seasons/:year/submissions` (upsert one manager's submission for a
  period; server stamps `submitted_at`/`approved_at`), `DELETE …/submissions/:period/:manager`
  (remove one), `DELETE …/submissions` (clear all — for Reset Season Data). `submissionBucket()`
  routes pp1→`initial_submissions`, others→`period_submissions[period]`.
- **Server full-save is now server-authoritative for submissions:** in `POST /api/seasons/:year`
  the `existingSd` merge block resets `sd.initial_submissions`/`sd.period_submissions` to the
  server's copy, so a full-season save can never clobber them. (Brand-new season has no
  `existingSd`, so its first save still establishes the empty buckets.)
- **Client:** added `persistSubmission(period, manager, sub)` + `removeSubmissionRemote()` +
  `mirrorSubmissionLocally()` (await a confirmed response, mirror into localStorage, alert on
  failure). Rewired **all 14** submission handlers (add/remove/submit/approve/deny/edit/delete
  for PP1 and the periods) to await these instead of `saveSeason`. Approve/edit-approved persist
  the submission **first**, then do their roster/`roster_dates` side-effects via `saveSeason`
  (rosters are still saved the old way; only the submission buckets moved). Reset Season Data
  also calls the bulk `DELETE …/submissions`.

Note: `backfillSubmissionTimestamps` still uses `saveSeason`, so its cosmetic timestamp fills
no longer persist server-side (they apply to the local view each load — harmless). Auth posture
unchanged (`requireAuth` on upsert/delete, matching the full-season save it replaces).

## PP1 submission window gating + delete capability (2026-06-06)

Commissioner saw stray "Pool Play 1 / Pending" entries during the PP2 window and
read them as misrouted PP2 submissions. They weren't — PP1/PP2 routing is correct
(`getPeriodSub`/`ensurePeriodSub` keep `initial_submissions` vs
`period_submissions[period]` strictly separate). Root cause: the legacy PP1
("initial") submission card never closed. Unlike `buildPeriodSubmissionCard`
(pp2/qf/sf/finals), the PP1 card's editable branch had **no `isPeriodTimeOpen`
check**, so a manager whose PP1 was never approved still saw a fully editable +
submittable PP1 form mid-season and could drop a fresh `pending` PP1 into the queue.
Worse: `repairGhostInitialRosterPlayers` (runs every active-season render) treats any
**populated** `initial_submissions` record — even `pending` — as the authoritative
Week-1 roster and purges Week-1 players/stats not in it, so a stray PP1 re-submission
with a different roster can silently corrupt PP1 scores.

- **PP1 now uses the same window as every other period:** added `pp1: 'PP1'` to
  `PERIOD_OPEN_ROUND`, so PP1 opens the Friday before its Week 1 (3 days before the
  Monday start) and closes at its first games (`getPeriodFirstGame`, already had pp1).
  Behavior change for **future** seasons only (PP1 used to open as soon as the pool
  was uploaded); current season's PP1 is long past so it now reads as closed.
- **Gated the PP1 card's editable form** on `isPeriodTimeOpen(sd,'pp1')`, mirroring the
  playoff cards' "opens X" / "window has closed" states. No more editable/submittable
  PP1 form after PP1 has begun.
- **Added `deleteInitialSubmission(manager)`** (+ a "Delete" button on the commissioner
  PP1 pending entry). Unlike Deny (leaves an empty `draft` record), this removes the
  `initial_submissions[manager]` key entirely. Safe: the season-save POST does not
  merge-protect `initial_submissions`, and the actual Week-1 roster lives in
  `sd.rosters` — deletion clears only the submission artifact and drops the manager
  from the ghost-purge loop. Used to clear the stray PP1 entries.

Frontend-only (`app.js`); no `SCORING`/`SEASON_SCHEDULE`/server changes.

## Phase 3 — retire the hardcoded band-aids (2026-06-06)

After the eligibility + array fixes stabilized the league, removed the first-season
band-aids so this class of issue can't recur and the code stops carrying
player-specific repairs.

- **3a — `POST /api/seasons/:year/initial-submission { manager, batters, pitchers }`**
  (commissioner): generic set/override of a manager's PP1 submission at any time.
  The reusable replacement for hardcoded "missing submission" repairs. Used to fix
  Anton (+Kerry Carpenter, the real 4th batter) and Austin (+Tarik Skubal, the real
  3rd pitcher).
- **3b — deleted three hardcoded repairs** from `server.js` + their startup calls:
  `repairMissingSwapRecords`, `repairMissingRosterChains` (the Anton/Carpenter +
  Austin/Skubal chains), `repairBentivegnaPitcherRoster`; and the client copy of
  `repairMissingSwapRecords` in `app.js` (+ its per-render call). Their effects were
  already persisted in `db.json` (swaps + roster_dates), so deletion is a no-op at
  runtime — they were gated one-shots that had already run. Net −524 lines.
- **Hardened `repairGhostInitialRosterPlayers`:** its `commAdded` protection now
  covers players in ANY approved swap (in/out, any week), not just Week-1 swaps —
  so a legitimately-swapped player can never be purged from Week 1 as a "ghost".
- **Kept** the general logic: `repairCarryForwardRosters`, `backfillRosterDatesFromSwaps`,
  `syncPlayerDatesFromRosterDates`, `repairGhostInitialRosterPlayers`,
  `purgeCarriedForwardDropRecords` (generic, not player-specific), and the structural
  one-shots (`applyMLBApiTakeover`, `backfillWmmcQS`).
- **Follow-up done:** `getPeriodFirstGame` (app.js) now falls back to the period's
  first scheduled games (Week-1 start of that round via `PERIOD_FIRST_GAME_ROUND`)
  when no explicit `period_deadlines[period]` is set. So a submission stays editable
  until that period's first games without manual deadline config (e.g. PP2 auto-opens
  Fri-before and auto-closes at its first games). Explicit `period_deadlines` still
  wins; commissioner can always override via the initial-submission endpoint.

## Scoring eligibility fixes — cross-manager leak + carry-forward (2026-06-06)

Root cause of the recurring Overall-standings swings, found via `/api/diag/manager`
on real data (Anton Capria, Austin Johnson). Two bugs in `managerWeekSubtotal`
(duplicated in **server.js** and **app.js** — keep both in sync):

- **Bug A (cross-manager leak):** `approvedSwaps` was `swaps.filter(status==='approved')`
  with **no manager filter**, then used to build the per-week eligibility set. A
  newly-added player whose weekly row wasn't yet attributed (`manager: null`) got
  pulled onto _every_ manager who had a swap that same week (e.g. Austin's Shane Baz
  / Bubba Chandler / Joc Pederson showed up in Anton's Week 5). Fix: scope
  `approvedSwaps` to `s.manager === managerName`.
- **Bug B (carry-forward eligibility):** eligibility only considered the _current_
  week's roster array + that week's roster_dates/swaps. A player added in an earlier
  week and never dropped (e.g. Devers added 5/9) stopped scoring the next week
  whenever a stale roster array (or a first-season repair) hadn't carried them into
  later weeks' arrays. Fix: add `activeByDates` — players whose most-recent
  roster_dates event (as of this week's end) for this manager is an add. Additive
  (can only restore under-counted scores; never reduces a correct one). Mirrors the
  frontend `isStillActiveForMgr`, evaluated per week.

Verified against the real diag data: Anton's Devers now counts Weeks 2–5, Austin's
Alcántara counts Weeks 2–3, both resolve to the correct 4 batters / 3 pitchers each
week. This fixes the scores **without any data surgery** — the add/drop history in
`roster_dates` was already correct; only the roster _arrays_ were stale.

The per-player roster **view** still read the stale arrays (showing carried-forward
swap-ins as greyed / missing / only-first-week points), so added
`POST /api/seasons/:year/rebuild-roster-arrays` (commissioner) + the generic
`rebuildRosterArraysFromDates(sd)`: a purely **additive** pass that, for each
existing week, adds any player active per `roster_dates` but missing from the array.
Never removes a slot. Type (batter/pitcher) comes from the manager's own arrays +
weekly rows first; pools only classify single-type players (so two-way Ohtani is
never forced onto a manager who didn't roster him both ways). Run once per season to
heal stale arrays; totals don't move (scoring already derives eligibility from the
same dates — the endpoint returns a before/after check to confirm).

Follow-up (next PR): correct the two `initial_submissions` (Anton missing Carpenter,
Austin missing Skubal), add a generic commissioner "edit initial submission until
first games" capability, then delete the hardcoded band-aid repairs and harden the
ghost-purge.

## Score-swing guard + daily snapshot trail (2026-06-06)

Added a safeguard against wild downward swings in the Overall standings (a
recurring problem — the standings are recomputed live from rosters + add/drop
dates + swaps on every compile, so one bad date/swap can move a cumulative total
by hundreds of points).

- **`detectScoreSwings(before, after, opts)`** — pure, unit-tested in
  `js/scoring.js`; **synced copy in `server.js`** (the only runtime caller; server
  is CJS and can't import the ESM module). Compares per-manager Overall totals.
  Thresholds (per commissioner, 2026-06-06): **blocks on a drop of ≥40 pts** for
  any single manager (scores normally only go up, so a real downward move is the
  thing we care about); an **upward jump of >200 pts only warns** (up is normal,
  but a jump that big is worth a look — possible double-credit). Applies uniformly
  to daily and Wednesday/Sync-Now compiles — a legit MLB stat correction that
  drops someone 40+ pts will block and must be re-run with Force.
- **`captureScoreSnapshot(sd, date)`** mirrors `computeRoundScores` attribution
  (added an optional `detailOut` param to `managerWeekSubtotal` to collect
  per-player rows without changing its numeric return). Stores per-manager
  totals plus a per-week / per-player breakdown in `sd.score_snapshots`, pruned
  to `MAX_SCORE_SNAPSHOTS = 21` (one per date; same-day re-run replaces).
- **Wired into:** the 4am auto-sync (blocks → skips writeDB, keeps last-good
  scores, Slack-alerts; the 7am scoreboard then posts the good numbers), and the
  commissioner `POST /api/mlb/sync-current` + `POST /api/mlb/sync` (block returns
  **409** with the report; re-submit with `{ force: true }` to override).
- **Diagnosis:** `GET /api/mlb/score-guard?year=` lists snapshot totals;
  `&from=DATE&to=DATE` returns a player-level diff ("what changed?"). No UI yet.
- Slack alerts go to the general `SLACK_WEBHOOK_URL` (same channel as sync errors).

## Weekly Team Scoring rework (2026-06-05)

Rebuilt the Weekly Team Scoring page (`renderWeekly` in app.js) into three grouped
sections — **Weekly**, **Per Round**, **Overall** — each with Batting / Pitching /
Total, replacing the old loose BAT/PIT/RK columns.

- **`enrichTeamWeekly(rows, schedule)` in `js/scoring.js`** (exported, on `window`,
  unit-tested) is the single source of truth. Given base rows carrying only
  `weekly_batting/pitching/total`, it stamps:
  - `round_*` — cumulative within a round, **resets** each round (PP1→PP2→QF→…).
  - `overall_*` — cumulative across the **whole season** (continues through playoffs
    for managers who advance). Chronological order = round position in `SEASON_SCHEDULE`
    × 1000 + numeric week, so it also handles legacy historical data whose weeks run
    continuously (Week 1..16) with non-schedule round keys (PP2 wk 6-10, QF wk 11-12, …).
  - `rank[field] = { pool: {rank,total}|null, ovr: {rank,total} }` for all nine
    metrics. Ranks compare managers sharing the same `(round, week)`: `ovr` vs every
    manager active that week, `pool` vs same-pool managers only. **Assumption:** the
    Overall-section rank cohort is "managers active that week" (so in playoff weeks
    only advancing managers are ranked), not all season managers. Flag if wrong.
- Ranks render as two small rows under each value: `Pool: x/total` / `OVR: x/total`
  (matches My Roster's `rank/total` style). Helpers `teamWeeklyMetricCell` /
  `teamWeeklyRankLines` in app.js; styles under `.weekly-grouped` in styles.css.
- `buildTeamWeekly` calls `enrichTeamWeekly`. `renderWeekly` also enriches on demand
  (guarded by `!rows[0].rank`) because **historical seasons** load raw `team_weekly`
  straight from `data.json` (`DATA = seasonData.data`) and never go through
  `buildTeamWeekly`. Enrichment is idempotent — recomputed from the `weekly_*` values.
- Added global `enrichTeamWeekly` to `.eslintrc.json` (app.js is a classic script).

## Google Sign-In (added 2026-06-04)

"Sign in with Google" on the login page, alongside email/password.

- **Gated by `GOOGLE_CLIENT_ID` env var** (OAuth 2.0 Web client ID, set per Render service). Unset → button hidden, email/password unaffected. Client ID is served to the browser via `GET /api/auth/config`; it is NOT a secret.
- **Server-side verification, no new dependency:** `verifyGoogleIdToken()` in `server.js` checks the ID token's RS256 signature against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached per Cache-Control) using built-in `crypto`, then validates iss/aud/exp/email_verified. The earlier scaffolding decoded the JWT client-side without verifying — that was insecure and is gone.
- **Auth model preserved:** `POST /api/auth/google` issues a per-manager `authToken` (random hex stored on the manager record). `loadManagerFromHeaders` accepts it in the `X-User-Password` header just like a password, so Google users get full access (swaps, commissioner) with no session store. `authToken` is a credential: stripped from `GET /api/managers` and the committed seed, preserved across manager saves like `password`.
- **Email mapping:** managers have a `googleEmail` field (editable in the admin panel, shown as a "Google Email" column). The Google account's verified email is matched against `googleEmail || email`. A one-shot startup backfill defaults `googleEmail = email` for every manager. Use it when a manager's Google address differs from their league email.
- **Origins:** every browser origin must be listed in the Google Cloud OAuth client's Authorized JavaScript origins (exact scheme+host, https except localhost). Prod authorized: `https://wmmc.live` (+ `www` if it resolves). Staging would need its own client ID + `https://wmmc-staging.onrender.com` authorized — not set up, so the staging button stays hidden.

## Deployment workflow (established 2026-06-04, updated 2026-06-05)

After completing any feature branch, **always auto-push to `staging`** (no
confirmation needed unless there are open questions or merge conflicts), then
**prompt** to promote to prod and delete the branch:

1. **Squash-merge** the feature branch into `staging` and push:
   ```
   git checkout staging && git merge --squash <feature-branch>
   git commit -m "<summary>"
   git push origin staging
   ```
2. **Prompt the user** (via AskUserQuestion) whether to merge to prod and delete the
   branch — e.g. "Pushed to staging (wmmc-staging.onrender.com). Merge to prod and
   delete `<feature-branch>`?"
3. **On approval**, merge `staging` into `main`, push, then delete the feature branch
   locally and on origin:
   ```
   git checkout main && git merge staging && git push origin main
   git branch -d <feature-branch> && git push origin --delete <feature-branch>
   ```

Do NOT ask whether to push to staging — just do it at the end of every session unless
there is an explicit reason not to (e.g., the user said "don't push yet"). Only the
prod merge + branch deletion needs the prompt. If the user has already said to go all
the way to prod, skip the prompt and run steps 1 → 3.

## Git identity — run at session start (established 2026-06-04)

The pre-push hook stamps `version.json` as a new commit. If `user.email` isn't
`noreply@anthropic.com` at that moment the commit is unverified. Always run this
before the first push in any session:

```
git config user.email noreply@anthropic.com && git config user.name Claude
```

## Mobile CSS patterns (established 2026-06-04)

- Manager name font: `clamp(1rem, 4.5vw, 2.2rem)` in live section (5 columns); `2.2rem` fixed in scoreboard (3 columns — more room).
- Header h1 (WMMC abbreviation): `clamp(1rem, 5vw, 1.6rem)`; use `.header-title-long` / `.header-title-short` spans with `!important` on `display` to guarantee the abbreviation shows on mobile.
- All three header elements (h1, season-selector, user-bar) use `flex: 0 1 auto; min-width: 0` so they share space proportionally without overflowing.
- Season `<select>` on mobile: `background: transparent` so it doesn't render as a big white/dark box against the header gradient.
- Live title row: `flex-wrap: wrap` so long pool-play week names don't overflow — date nav drops to a second line gracefully.
- Font overrides that compete with `styles.css` need `!important` (e.g., `#live-week-title`, `.live-game-line`).
- Today's Games game rows: `1.9rem` (2× the 0.95rem base) with `!important`.

## Mobile full-tab redesign (established 2026-07-03, PR #335)

All tabs now have phone-first layouts in `mobile.css` (previously Scoreboard only).
Decisions made with Daniel (asked via option picker):

- Scope: all tabs; wide tables → card rows with tap-to-expand (not column-pruning
  or side-scroll); full 16px+ mobile type scale (not a moderate bump); contrast
  refresh approved (keep navy/red identity).
- Contrast is done by overriding `--text-light` / `--text-muted` / `--border`
  inside the ≤768px media query (light + `html.theme-dark` both) — never per-component.
- Live Running Standings pattern: `tr.live-mgr-row` → flex card; a `tr::after`
  flex item with `flex-basis:100%` + `order:1` forces the line break between the
  rank/name/total line (order 0) and the stat chips (`td:nth-child(n+4)`, order 2,
  labels via `::before`). Chip label text lives only in CSS.
- The outer table→block transform must be scoped with a child chain
  (`#live-managers .card > .table-wrapper > .data-table`) so the batter/pitcher
  tables inside the expand panel stay real tables.
- Expand-panel rows: set `display:block` on `tr.live-mgr-detail-row` WITHOUT
  `!important` — app.js collapses panels via inline `display:none` and expands via
  `display:''`, so plain CSS block applies only when expanded. An anonymous
  table-row otherwise sizes to the wide inner table and overflows the card.
- Flex/blocked table cells still inherit `text-align:center` from `.data-table` —
  set `text-align:left` explicitly on name cells.
- `.data-table.accolade-detail-table` sizes must be re-pinned compact after any
  global mobile `.data-table` bump (equal specificity, mobile.css loads last, so
  the last rule wins) — those tables must fit their box with no side-scroll.
- Verification pattern: Playwright at 412×915 via the global install
  (`require('/opt/node22/lib/node_modules/playwright')`, executablePath
  `/opt/pw-browsers/chromium`); local login = set a `password` on a manager in
  the gitignored `db.json`; Live tab CSS verified by injecting the exact app.js
  markup with fake numbers into `#live-managers` / `#live-games`.
