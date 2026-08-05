# WMMC — Decisions Log

## A mid-week swap erased the outgoing player from My Roster's week (2026-07-29)

**Symptom (manager).** Skubal was swapped in for Gavin Williams on 7/29, mid-QF Week 2. The
scoreboard's period panel listed both (Williams tagged `7/20–7/28`), but My Roster's
`QF - Week 2` section showed only Bibee, Drohan and Skubal — the player who had been rostered for
the first two days of that week was simply gone.

**Root cause.** `buildPerWeekRoster`'s `droppedBatters` / `droppedPitchers` gate required a player
who is no longer on the week's roster array to (a) have a weekly stat row for the week and (b)
have `weekly_score > 0`. The intent was to suppress noise rows for post-drop games. But a player
swapped out early in a week routinely fails both: their in-window days can be blank, and if they
never played inside the week the sync never writes a weekly row at all — so the row vanished
instead of showing zeros. The scoreboard was unaffected because it lists a player once they score
in **any** week of the period, and Williams had scored in QF Week 1.

**Fix.** Keep the points gate, but OR it with a real window test: `rosteredDuringWeek(player)`
reads the player's `add_date`/`drop_date` from **this week's `roster_dates` entry** (source of
truth), falls back to the approved swap that moved them, and keeps the player when that window
overlaps the week's schedule range at all. Because the eligibility sets are type-agnostic
(`roster_dates` keys span both lists), the statless branch is gated on `poolTypeOf(player)`. The
same gate — the same defect — was in the commissioner's per-week roster manager
(`updateCommRosterWeekView`), so it got the same treatment; `commPoolTypeOf` was hoisted out of
the pending-drop block to make that possible, and the dropped-player tag there now opens the span
at the week start instead of a bare `?` when the add lives in an earlier week.

**Score-neutral by construction** — nothing here touches `roster_dates`, `swaps`, the eligibility
sets that feed `batTotal`/`pitTotal`, or any scoring path; the added rows carry the player's own
window-scoped stats and contribute 0 to a week they earned 0 in. Verified in the running app
against a fabricated QF-in-progress season: a full dump of every scoreboard row, week header, week
total and subtotal for all 8 managers is **byte-identical** before and after. Three scenarios
driven with Playwright at 1280×950 and 390×844: swap effective today → Williams renders greyed as
`7/20–7/28` directly above Skubal, week total unchanged at 55; swap in QF Week 1 → he shows in
Week 1 and does **not** leak into Week 2; scheduled (future) swap → unchanged, he stays active
with `Drops Jul 30` and Skubal reads as scheduled. No page errors, no horizontal overflow.

## Eliminated managers' stale playoff rosters blocked the swap pool (2026-07-29)

**Symptom (commissioner).** Tarik Skubal was on no surviving manager's roster but never appeared in
the swap form's "Player In (available)" search — while the commissioner's roster-management lookup
(which only excludes the editing manager's own roster) listed him normally.

**Root cause.** `isCurrentlyTaken` in the swap form asked each manager "do you hold this player",
answering from period-scoped `roster_dates` first and falling back to the manager's LATEST week
roster array when the player had no date events in the period. The fallback had **no period
scoping**: `orderedWks.filter((wk) => mgrRoster[wk]).pop()`. A manager eliminated in the QF still
has their `QF|Week 2` array on file, so a player on it read as rostered forever — the same
period-leak family as the 2026-06-08 carry-forward bugs, in the one place the array fallback was
never scoped. Compounding it, the form derived its period with a local "latest STARTED round" loop
while `getCurrentScheduleRound` (and the server's `currentScheduleRound`, which stamps the swap's
round) return the current **or upcoming** round — so in a between-rounds gap (QF over, SF lineups
going in) availability was judged against the round that just ended.

**Fix.** New canonical `periodWeekKeys` + `rosterStatusForManager` in `js/eligibility.js` (built on
`rosterStatusAsOf`); `app.js`'s two inline helpers now call it, the array fallback is limited to the
current period's week keys, and the period comes from `getCurrentScheduleRound`. Status is read
**as of today**, so a scheduled swap no longer applies early in either control: the outgoing player
stays in Player Out until their drop date, the incoming one reads `scheduled` (still counted as
taken, so nobody else can claim them) until their add date. Managers for the "is anyone holding
this" sweep now come from `getManagers()` (db.managers) unioned with roster-data keys, per the
invariant.

**Score-neutral by construction** — availability is a render-time read; no scoring, `roster_dates`,
or `swaps` path is touched, so no total can move. Verified in the running app on a fabricated
SF-in-progress season with a QF-eliminated manager: before, "tar" returned only Pintaro/Alcantara
(exactly the reported screenshot); after, Tarik Skubal is listed, while players on a live SF roster
stay out of the pool. PR #377.

## Managers can edit/cancel their OWN swap until it takes effect (2026-07-28)

**What (commissioner request).** A manager who schedules a swap should be able to change or cancel
it themselves right up until the effective date; once it applies, only the commissioner can touch
it. Buttons live on the swap itself in My Roster → Swaps.

**The rule, in one line:** a swap is the manager's to change while `today < swap.add_date`. Before
that nothing has moved — the incoming player is not on the roster and the outgoing player is still
scoring — so a change or cancel is free. From the add date on, the roster windows are live and it
is the commissioner's call. Same predicate as the `swapIsScheduled()` badge added the same day.

**Server (the authority).** New `swapModifyGuard(req, swap)` returns the rejection for a
non-commissioner unless the swap is theirs, is `approved`/`pending`, and is still scheduled.
Both endpoints moved from `requireCommissioner` to `requireAuth` and call it:

- **`PUT /swaps/:id`** — commissioner behavior is untouched. A manager may change only the
  **effective date** and the **reason**. Deliberately NOT the players: a player change on a live
  record leaves the previous pair's roster windows behind, and the swap-limit/IL checks belong to
  the submission path — so a manager cancels and resubmits, which refunds the slot (`checkSwapLimit`
  counts only approved/pending) and re-runs every check. A manager's date goes through the same
  rules submission enforces (strictly forward, ≤ round end) and is rebuilt into the canonical
  scheduled shape server-side (drop = add − 1, effective = add), so the client only sends
  `add_date`. A reason change re-runs `checkSwapLimit` with THIS swap excluded (so re-saving an
  unchanged reason can't collide with itself) and re-verifies IL status when the new reason is
  `IL Swap`. `force` is rejected for managers.
- **`POST /swaps/:id/undo`** — a manager can cancel their own scheduled swap. `force` is
  commissioner-only, and the 409 carries a manager-readable `detail` pointing at the commissioner.

**Client.** `managerSwapActionsHtml` adds **Edit swap** / **Cancel swap** to the swap-log detail
panel for the owner while it is scheduled (an inline Effective Date + Reason form, min = tomorrow,
max = round end), and a read-only "already taken effect — ask the commissioner" note once it is
live. Commissioners keep exactly the controls they had (Undo + inline date inputs) — the manager
buttons are the `else` branch, so there are never two sets. `persistSwapMutation` gained an
`onError` callback so these rejections render inline instead of in an `alert`, and it only offers
the destructive-guard force retry to a commissioner.

**Verified** with a 19-check API permission matrix, each phase on a fresh fixture DB (another
manager's swap → 403 `not_your_swap`; player/`force` fields → 403 `manager_field_not_editable`;
today-or-earlier → 400 `effective_date_not_future`; past round end → 400
`effective_date_past_round`; own scheduled swap edit → 200 with windows re-stamped and the
canonical shape preserved; cancel → `undone` with the incoming player's window erased and the
outgoing player's drop lifted; undone swap → 409 `swap_not_open`; backdated swap → 403
`swap_already_effective` for the manager but 200 for the commissioner). Playwright drove both
buttons end-to-end as a NON-commissioner at 1280×950 and 390×844: the edit moves the date and the
per-week roster table updates live to "Drops Jul 31" / "Adds Aug 1", the cancel restores the
outgoing player as a plain active row, no page errors, no horizontal overflow. Commissioner view
re-checked as unchanged. Per-manager totals byte-identical. 169/169 tests, lint + format clean.

**Fixture gotcha worth remembering.** A synthetic season with weekly rows but NO daily rows makes
any date edit look catastrophic: `recomputeMidWeekAddScores` re-windows the weekly score, finds no
dailies to re-sum, and zeroes it — tripping `assessSeasonWriteIntegrity` with a fake ≥40-pt crater.
It fires identically for the commissioner, so it is the fixture, not the product. Give the players
a date edit touches real `daily_batting`/`daily_pitching` rows before concluding anything.

## A scheduled swap must not apply early in the roster VIEWS (2026-07-28)

**Symptom (commissioner).** A swap submitted 7/28 effective 7/31 showed all the right
"scheduled" verbiage on the form, but "the swap appears to effectively be in place immediately."
On My Roster's current week the outgoing player (Drohan, drop 7/30) had vanished from the pitcher
table and the count read PITCHERS (3) with the incoming player (Mize, add 7/31) already in it;
the scoreboard detail panel greyed Drohan as `dropped-player` while Mize rendered active; the
Live tab credited Mize (not yet rostered) and dropped Drohan.

**Root cause.** `roster_dates` was correct the whole time — which is why SCORING was never wrong,
and why per-manager totals are byte-identical before and after this fix. The views were the
problem: every one of them asked "is this player rostered?" with an upper bound of the WEEK/PERIOD
END rather than TODAY, so a drop or add anywhere later in the same week read as already applied.
Compounding it, `applySwapToSeason` pulls the outgoing player out of `sd.rosters[mgr][weekKey]`
immediately on submission — and a scheduled drop's player typically has 0 points so far this week,
so `droppedPitchers`' "only show a dropped player who banked points" filter hid him entirely.

**Fix.** New canonical pure helper `rosterStatusAsOf(entries, { periodStart, asOf })` in
`js/eligibility.js` (unit-tested; bridged to `app.js` through `js/index.js`), returning
`active | dropped | scheduled | none`. A pending drop with no effective add still reads `active`,
which covers a submission player (no `add_date` of their own) being dropped by a scheduled swap.
Applied in four places:

- **`buildPerWeekRoster`** (My Roster per-week): pending-drop players are put BACK into the week's
  roster arrays (the arrays are a derived cache; `roster_dates` is the source of truth) and their
  tag reads in the future tense ("Drops Jul 30"); pending-add players stay listed but get
  `.wrs-sched-row` + "Adds Jul 31" and are excluded from the BATTERS/PITCHERS count.
- **`buildManagerDetailPanelHtml`** (scoreboard expand): the as-of date is clamped into the
  period's own window — a finished period still reads at its end and a not-yet-started one at its
  start (so an early submission is unaffected), but an IN-PROGRESS period now reads as of today.
  Scheduled players get `.scheduled-player` + a "Scheduled" pill.
- **`updateCommRosterWeekView`** (commissioner per-week editor): same treatment. The Drop button
  keys off raw array membership (`canDrop`), not the new status, so a commissioner can still
  cancel a scheduled add.
- **`GET /api/mlb/live`** (server): the roster derivation is bounded by `today` instead of the
  week's `end` (today is inside the week by construction there).

**Also fixed in the same PR** (both reported alongside): the Swap Log detail panel's "Undo swap"
row landed in the grid's last column, where the button + its note overflowed the panel and made
the whole page scroll horizontally — it now spans the grid as a footer (`grid-column: 1 / -1`),
and the panel's `minmax(220px, 1fr)` became `minmax(min(220px, 100%), 1fr)` so the grid can't
widen the table it sits in. My Roster → Swaps → "All Swaps" was a flat 5-column table with no
detail; it is now `renderSwapLog(containerId, editable, scopeManager)` — the same click-to-expand
log as the Swap Log tab, filtered to that manager, minus the Manager column and its filter. An
approved-but-not-yet-effective swap now carries a "Scheduled <date>" badge next to Approved.

**Verified** on a seeded temp-DB server reproducing the report (today = QF Week 2 day 2, swap
effective in 3 days), Playwright at 1280×900 desktop + 390×844 mobile, before/after on both
builds: baseline reproduced every symptom exactly (Drohan `wrs-hist-row`/`dropped-player`, Mize
active, Live attributing Mize, `document.body` scrolling horizontally); after, all four views show
the outgoing player active with a future-tense tag and the incoming player as scheduled, and the
page no longer scrolls. Per-manager totals — scoreboard rows, period score cards, per-week and
per-group subtotals, and the commissioner editor's BATTERS/PITCHERS pts — diffed byte-identical
(SAVE_HARDENING_PLAN §7). 169/169 tests, lint + format clean.

**Note for next time.** `sd.rosters` is genuinely "who was rostered at any point in this week"
after `rebuildRosterArraysFromDates`, but `applySwapToSeason` ALSO does an immediate out→in
rewrite of the swap's `week_key` entry. The two disagree for a scheduled swap. Don't try to fix
that in the server — the arrays are a derived cache by design and changing their semantics moves
`findManagerForPlayerWeek`, Best/Worst and the Live tab. Fix the reader, as here.

## Today is always a valid swap effective date — game start time, not the calendar (2026-07-25)

**Symptom (commissioner).** The swap form showed Effective Date `07/25/2026` (today) with the
Submit button refusing: "The effective date must be a future date — keep the suggested date to
apply the swap automatically." Neither player's team (both NYM) had started playing, so the swap
was legitimately eligible for today.

**Root cause.** "Is this a scheduled swap?" was decided by a sentinel comparison, not by a date
rule: `submitSwapRequest` treated ANY value differing from `data-auto-date` as a scheduled swap,
and both client and server then rejected a scheduled date `<= today`. So the moment
`data-auto-date` drifted from the input (a form re-render, a stale/failed teams-started check, or
the manager typing today's date back in), today's date was reclassified as a backdated schedule
request and blocked — even though today was exactly what the auto path would have produced.

**Fix (`app.js` + `server.js`, twin change).** Only a date **strictly after today** schedules a
swap. Today is never "scheduled" — it means "apply now" and routes to the auto path, where
`computeSwapEffectiveDates` / `computeSwapEffectiveDatesServer` (the teams-started check) decide
whether it lands today or tomorrow. So today is always submittable regardless of `data-auto-date`,
and a player whose game already started still correctly slips to tomorrow instead of erroring.
Only `< today` is rejected as backdating (client message + server 400 `effective_date_not_future`).
The commissioner is unchanged: any date, today included, stays an explicit correction (server
`isCommissioner` keeps the exact date rather than re-deriving it), so Swap Log date edits and
backdated corrections behave exactly as before. `data-auto-date` still exists — it now only
suppresses "user picked the same future date the auto path suggested", never gates today.

**Verified** on a seeded temp-DB server (staging fixture, schedule shifted so today = PP2 Week 3
day 3, stubbed statsapi via a `--require` fetch preload) — 27/27 checks: requested-today with no
games started applies today (drop yesterday / add today, no `requested_effective_date` recorded);
requested-today with the OUT player's team already playing bumps to tomorrow with `teams_started`
populated; blank behaves identically to today; yesterday 400s; tomorrow still schedules; past
round-end and malformed dates still 400; commissioner today keeps today even mid-game and
commissioner backdating still works; per-manager totals byte-identical after every case. Playwright
at 390×844 reproduced the exact report — auto-date drifted to tomorrow while the field read today —
and confirmed it now submits with "effective 2026-07-25" instead of the error, that backdating is
still refused client-side, and no page errors. 157/157 tests, lint + format clean.

## Scheduled swaps (manager, future-only) + commissioner date editing (2026-07-21)

**What (commissioner request):** now that swaps auto-apply, (1) managers can optionally pick a
FUTURE effective date on the swap form (no backdating — the server rejects any date ≤ today for
non-commissioners); (2) the commissioner can edit a swap's effective dates (drop/add) as well as
its reason, from the Swap Log detail panel and the pending-swap inline edit form.

**Key decisions:**

- **Submission (`POST /swaps`) takes optional `requested_effective_date`.** When set it overrides
  the game-started auto-dates with the same window shape (add = date, drop = day before,
  `teams_started: []` — the game-started rule is irrelevant for a future date) and is kept on the
  swap record (`requested_effective_date`, shown as "Scheduled For" in the log). Managers:
  strictly after today AND no later than the current round's end (`scheduleRoundEndDate`) —
  cross-period scheduling is invalid because rosters start fresh from a new submission (the
  period-scoping invariant); in-round future dates ride the proven machinery (approve has always
  taken arbitrary dates). Commissioners: any date. Round charged is still the round it's
  submitted in (`currentScheduleRound` from today — unchanged, no client/server drift).
- **`PUT /swaps/:id` now accepts `effective_date`/`add_date`/`drop_date`.** Record-only edits
  (reason/players/swap_date) behave exactly as before. Changing add/drop dates on an APPROVED
  swap re-applies the roster windows via `applySwapToSeason` (same mutation as approve/auto-apply
  — windows re-stamp by overwrite, roster-array block is a no-op on re-apply) and is vetted by
  `assessSeasonWriteIntegrity`: 409 `destructive_swap_edit_blocked` unless `{ force: true }`;
  response carries `totals_delta`. Pending swaps stay record-only (approve reads the dates).
  `effective_date` follows `add_date` unless explicitly set (they're equal by construction).
- **Client:** swap form gained an optional "Effective Date" input (min = tomorrow, max = round
  end); a scheduled submission skips the teams-started fetch. Swap Log detail panel renders
  Drop/Add as inline date inputs for commissioners on pending/approved swaps only
  (`saveSwapLogDate` — pulls the authoritative season down after, since scores may recompute);
  the pending-swap inline edit form gained Drop/Add date fields. `persistSwapMutation` handles
  the destructive 409 with a confirm → force retry (mirrors approveSwap).
- **Verified** per SAVE_HARDENING_PLAN §7 on a seeded temp-DB server (staging fixture, schedule
  shifted so today = PP2 Week 4's last day): 30/30 checks — backdate/same-day/past-round-end/
  invalid rejected 400; scheduled swap auto-applies with correct record + `roster_dates` windows;
  manager PUT 403; commissioner date edit + backdate re-stamp windows; per-manager totals
  byte-identical before/after every operation. 155/155 tests, lint + format clean.
- **Follow-up (same day, commissioner request): the Effective Date field is never blank** — it
  prefills with the date the swap WOULD take effect if submitted as-is (the auto path) and
  `refreshSwapAutoEffectiveDate` keeps it live as players are picked (today ↔ tomorrow via the
  teams-started check; only overwrites while the value still equals the last auto value, so a
  user-picked date is never clobbered). `data-auto-date` tracks the latest auto value;
  submitSwapRequest sends `requested_effective_date` ONLY when the value differs from it —
  leaving the suggested date submits through the unchanged auto path. Server untouched.
  Verified with Playwright (desktop 1280×900 + mobile 390×844 via the `#my-roster` hash
  deep-link): 12/12 checks — prefill, live today↔tomorrow refresh with a stubbed
  `/api/mlb/teams-started`, untouched-date submit has no `requested_effective_date`,
  changed-date submit schedules correctly. NOTE the swap form lives in the roster page's
  `rtab-swaps` SUB-tab (`.roster-tab[data-rtab="swaps"]`), and on mobile the nav buttons are
  behind the hamburger — deep-link via URL hash instead of clicking `.nav-btn`.
- **Gotcha (harness):** the server rewrites `managers_seed.json` on boot from the live DB — a
  smoke server started with `cwd: repo` + a scratch `DB_PATH` clobbers the committed seed with
  the fixture's synthetic managers. Restore it (`git checkout -- managers_seed.json`) after any
  temp-DB server run.

## Swap automation: auto-apply on submit + playoff limits + MLB IL verification (2026-07-20)

**What (commissioner request):** managers' swap submissions no longer wait for commissioner
approval — they apply immediately with the existing effective-date logic. Rules enforced at
submission: pool play = one Free Swap per PP round + unlimited IL/Drop/Trade (unchanged);
playoffs (QF/SF/Finals) = ONE swap total per round across Free/Drop/Trade + unlimited IL (NEW —
was one per type per round). IL swaps are verified against the player's official MLB IL status.
Ineligible swaps get a warning and are blocked. Swap log + commissioner undo unchanged.

**Key decisions:**

- **Rich Slack swap posts + deep link (same-day follow-up):** all swap notifications
  (`buildSwapSlackText` in server.js) mirror the Swap Log detail rows — out/in with team
  abbreviations, drop/add dates, reason + verified IL status, round · week, effective date,
  submission time in ET — and end with a link to `http://wmmc.live/#swap-log` (`WMMC_SITE_URL`).
  app.js gained minimal hash deep-linking: after login, a `#<tab>` hash matching a `.nav-btn`
  `data-tab` wins over the localStorage-saved tab (only `#swap-log` is emitted today). Verified
  live: captured the webhook payload with a local listener, and Playwright confirmed
  `/#swap-log` + saved-tab=dashboard lands on the Swap Log.
- **Server is the enforcer.** `POST /api/seasons/:year/swaps` now: verifies the authed user IS
  the named manager (or commissioner, 403 otherwise), computes round/week_key itself
  (`currentScheduleRound`), runs `checkSwapLimit` (400 + warning on failure), verifies IL via
  `fetchPlayerILStatus`, recomputes effective dates server-side (`computeSwapEffectiveDatesServer`
  - shared `fetchStartedTeamsToday`), then applies via `applySwapToSeason` — the mutation
    extracted verbatim from the approve endpoint, so approve and auto-apply can never drift.
    Auto-applied swaps are `status:'approved'` + `auto_approved:true`.
- **Integrity-guard fallback, not rejection:** if `assessSeasonWriteIntegrity` flags the apply as
  destructive, the season is restored and the swap is queued as `pending` for commissioner review
  (`pending_review:true` in the response, Slack alert) — the pre-automation flow is the safety
  valve, and the approve/deny UI still exists for it.
- **IL check fails OPEN.** Uses `sd.mlb_ids` → `/api/v1/people/{id}?hydrate=rosterEntries`,
  IL = status code D7/D10/D15/D60 or description matching /injured list/i. No id / no entry /
  API error → `il_status:'unverified'` and the swap proceeds (an MLB outage must never block a
  legit IL swap). Verified status is stored on the swap as `il_status`.
- **`checkSwapLimit` is a NEW dual-copy function**: canonical in `js/swaps.js` (unit-tested,
  window-bridged for the form's pre-check) + identical mirror in `server.js`. Documented in
  CLAUDE.md gotchas. Denied/undone swaps refund the slot (undo → re-eligible, intentionally).
  Commissioner Swap reason bypasses limits (commissioner only).
- **Round detection fix (client+server):** between weeks (All-Star break / round gaps) the swap
  now charges the UPCOMING round, not Finals (old client code fell through to Finals in gaps).
- **Swap form UX:** "Make a Swap", explains auto-apply; outcome message is baked into the form
  render via `_swapFormNotice` because renderRosterData (and its daily-stats re-render) rebuilds
  the form DOM and wiped any directly-written message (pre-existing bug, invisible before because
  approvals happened out-of-band). After an applied swap the client re-pulls `/api/seasons`.
- **Verified** end-to-end on a scratch db (API + Playwright): auto-apply, roster windows
  (drop yesterday/add today with no games started), per-manager totals unchanged (95/95/95),
  PP free-swap block, playoff combined-slot block (Free+Trade blocked after Drop; IL allowed),
  403 for other-manager submission, same-day duplicate guard, undo restores roster + refunds
  slot, IL fail-open when statsapi unreachable. 155/155 tests, lint+format clean.

## Live tab playoff bracket view + bracket mobile readability (2026-07-20)

**What (commissioner request, day 1 of QF):** (1) the Live tab during QF/SF/Finals should read
as a playoff bracket, not a "Running Standings" rank table; (2) the recent pool-play scoreboard
display/visibility improvements (mobile type scale, full names, readable expanded player
panels, labeled expand affordance) must carry over to the playoff scoreboard/bracket, which
had none of them.

**Key decisions (display-only — no writes to managers/rosters/swaps/scoring):**

- New `playoffRoundMatchups(sd, round)` (app.js) returns the round's head-to-head pairs in
  bracket display order by reusing the canonical helpers (`getQFQualifiers` /
  `getSFParticipants` / `getFinalsParticipants`), so the Live view can never disagree with the
  Playoff Bracket card. Finals returns Championship + 3rd Place. Returns `null` when
  participants aren't determined (no 8-manager seeding, prior round unfinalized) — both Live
  renderers then **fall back to the existing standings table**, and pool play is untouched.
- Both the live (today) and historical-date Live views share `renderLiveMatchupCards`: seed +
  name + total per team, a muted subline replacing the dropped table columns (live: today Δ ·
  live/done/left counts · weekly; historical: daily Δ · weekly), and the same
  `live-detail-<key>` ids / `_liveExpandedManagers` set so the expandable per-player panels and
  `toggleLiveManagerDetails` work unchanged across the 2-minute poll re-render. Leader tint is
  purely visual (missing manager rows count 0; ties highlight nobody) — official winners stay
  finalize-time on the Scoreboard bracket with the seed tiebreak. Participants missing from the
  endpoint response (no approved roster yet) render an em-dash total + "No roster data yet".
- Bracket mobile parity: `mobile.css` previously had **zero** `#scoreboard-bracket` rules, so
  the pool-play readability work (and the roster-expand fix from #337) never reached the
  bracket — team rows rendered at 0.82rem and expanded panels at desktop 0.75rem. Added a
  bracket section mirroring the `.mob-sbrow` contract (≥16px names/scores, flex name that
  ellipsizes last, fixed score column) and the readable expanded-panel sizes (the
  `#scoreboard-content .mgr-detail-*` rules are ID-scoped and can't apply).
- Follow-up (same day, commissioner reviewed screenshots — density over explanation): the
  `.bracket-tap-hint` line added above was REMOVED (don't re-add explanatory text under the
  bracket title), the active bracket card title is "Playoffs" (was "Playoff Bracket"), and the
  Live matchup subline is forced to ONE row (nowrap + ellipsis; on phones the seed indent is
  dropped and the font shrinks to 0.78rem so the full line fits a 390px screen) — the goal is
  the maximum number of matchup rows visible without scrolling.

**Verified:** Playwright at 1280×900 and 390×844 against a seeded QF-week db (PP finalized,
confirmed seeding, QF Week 1 scores) with stubbed `/api/mlb/live` + `/api/mlb/daily`: 34/34
checks — bracket totals/splits + expanded QF player panels (≥16px on mobile), matchup cards in
QF1/QF4/QF3/QF2 order, leader/tie/no-data highlighting, expand-across-poll ids, historical
matchup view, no horizontal overflow, no JS errors. 140/140 tests, lint + format clean.

## Daily Slack post: playoff cadence + bracket matchups (2026-07-15)

**What (commissioner request):** stop the pool-play 7am auto post after the Monday following
PP2's end; nothing during the All-Star break (the "End Pool Play" roast/field post covers the
transition); each playoff round (QF/SF/Finals) posts daily starting its first TUESDAY (the
opening Monday's 7am run has no games to report); the first Monday after each round ends gets
one wrap-up post reporting the round that just finished ("and so on" through Finals).

**Key decisions (all in `server.js`, display/timing only — no scoring/roster writes):**

- `scoreboardAutoPostPlan(sd, todayISO)` gates the 7am run: `{summaryRound}` on the first
  Monday after a PP2/QF/SF/Finals round-end, `{}` daily in-round (pool play unchanged; playoff
  rounds only from `tuesdayOnOrAfterISO(round start)`), `null` otherwise. PP1's boundary
  Monday deliberately stays a normal daily post (falls inside PP2's window). The wrap-up
  Monday wins over the next round's window (SF Week 1 starts the Monday after QF ends — that
  Monday's post is the QF wrap-up; SF posts start Tuesday). Empty `schedule_dates` preserves
  the old always-post behavior. `last_scoreboard_post_date` idempotency guard untouched.
- During QF/SF/Finals, `buildScoreboardBlocks` drops the pool-play frames (Overall Standings +
  pool columns + legend) for `buildPlayoffMatchupsSlackText`: head-to-head matchups mirroring
  app.js `buildActivePlayoffBracket` (`confirmed_seeding.qualifierNames` seeds; QF 1v8/4v5/
  3v6/2v7; SF1 = QF1w vs QF4w; Finals = SF winners, 3rd place = SF losers with the app's
  t1-favoring tie). Winners derive from round totals + seed tiebreak directly (identical to
  the app's finalized bracket) so posts never wait on a finalize save. No confirmed seeding →
  degrade to a plain ranked round-total list. Wrap-up posts add ✅/❌, an advancing/champion
  footer, and a "complete! Final results below" line instead of the Current Period line.
- Manual `POST /api/slack/scoreboard` and the `/wmmc` slash command intentionally keep no
  gating (post-on-demand) but pick up the playoff matchup layout automatically.

**Verified:** scratch harness (extracted the new pure functions from server.js) asserting the
whole 2026 calendar day-by-day (PP daily through 7/13 PP2 wrap-up; silent ASB; QF daily
7/21–8/03 wrap-up; SF/Finals likewise; nothing after the 8/31 Finals wrap-up) and matchup
rendering incl. tie→seed and 3rd-place-tie→SF1-loser; block-assembly smoke for QF daily /
QF+PP2 wrap-ups / PP2 daily / no-seeding fallback. 140/140 tests, lint + format clean.

**What:** extended the Monte-Carlo playoff-odds engine (from the 2026-07-06 entry below)
so each remaining game's projected contribution isn't just "shrunk per-game rate x 1", but
"shrunk per-game rate x a per-game adjustment factor" reflecting who they're playing, where,
and whether it's a hitter- or pitcher-friendly park. User explicitly asked for this as a
follow-up after reviewing phase 1's methodology and confirmed the scope via two rounds of
AskUserQuestion (scope: opponent quality + home/away + park factors, all three; park-factor
source: commonly-cited multi-year averages since MLB's Stats API has no park-factor endpoint).

**Key decisions:**

- New pure exports in `js/playoffOdds.js` (synced copy in `server.js`, same convention):
  `HOME_ADVANTAGE` (flat +-3%, symmetric for both player types), `PARK_FACTORS` (hand-written
  30-team table of approximate multi-year park run-scoring multipliers — ATH/OAK and TB left
  neutral 1.0 since their current-season home parks were unstable/unconfirmed at write time,
  rather than guessed), `computeTeamQualityFactors` (team ERA/runs-per-game -> relative to
  league average, clamped [0.85,1.15]), `gameFactor` (combines opponent quality + home/away +
  park into one per-game multiplier, clamped [0.7,1.5] overall; park factor applies directly
  to batters and inversely to pitchers since a hitter-friendly park hurts pitcher fantasy
  scoring).
- `projectManager`'s contract changed: player entries now carry `gameFactors` (one multiplier
  per remaining game) instead of a scalar `gamesRemaining`. Mean scales by sum(factors);
  variance scales by sum(factors^2) (Var(sum ci*Xi) = sum(ci^2*Var(Xi)) for independent Xi).
  All-1.0 factors reproduce the old `mean*gamesRemaining` behavior exactly.
- Server-only glue: `fetchTeamIdAbbrevMap` (shared id->abbrev lookup), `fetchRemainingGamesByTeam`
  now returns each remaining game's {opponent, isHome, venueTeam} instead of a bare count,
  `fetchTeamSeasonQuality` (2 bulk MLB API calls — team-stats endpoint, hitting+pitching groups
  — not 30 per-team calls). Every new fetch is wrapped to fail safe to neutral (1.0) on error/
  missing data, never blocking the nightly compute — could not verify the live MLB
  `/api/v1/teams/stats` response shape from this sandboxed session (network policy blocks
  statsapi.mlb.com), so this needs a live smoke-test after deploy.
- Stored payload gained `managers[name].schedule_factor` (average per-game adjustment across
  a manager's roster, e.g. 1.11 = slate projects 11% above neutral) — surfaced as a new
  "Sched." column on the scoreboard's Playoff Odds panel with an explanatory tooltip; Slack
  footnote left unchanged (already terse by design).

**Verified:** unit tests for all new pure functions (computeTeamQualityFactors direction +
clamping, gameFactor direction for both player types + clamping + null-game fallback,
projectManager's new factor-scaling formula) — 131/131 total tests pass. E2E smoke test with
a stubbed MLB API (lopsided team quality: NYY strong/BOS weak) confirmed differentiation
end-to-end: an all-NYY roster (facing mostly weak BOS pitching, NYY's hitter-friendly park)
showed schedule_factor +11%, an all-BOS roster (facing mostly strong NYY pitching) showed
-13% — correct direction, propagated through to the stored payload, the Slack post, and the
rendered "Sched." column in Chromium.

## Playoff odds: Monte-Carlo prediction section, PP2 Weeks 4–5 (2026-07-06)

**What:** "Likelihood to make the playoffs" percentage on the scoreboard + a section in the
daily 7am Slack post, live only from the start of PP2 Week 4 through the end of pool play
(user's chosen window). Server-computed, client-displayed.

**Model (user chose Monte Carlo over a deterministic formula):** 10,000 sims of the remaining
schedule. Each manager's remaining PP2 production ~ Normal(mean, var) built player-by-player:
per-game scoring rate from the season's daily rows (batting+pitching merged per game_id,
shrunk toward the league per-game baseline with k=5 pseudo-games) × the player's MLB team's
remaining non-Final games (statsapi schedule + teams endpoints) within the window. Roster =
active PP2 players from roster_dates as of today (latest add ≤ today, no later drop, scoped
by periodStartForRound). Each sim applies the exact qualification rules (per-pool PP1/PP2
winners > 0, wildcards by combined total fill to 8; winners seed first). PP1 is complete in
the window, so PP1 pool winners are banked → shown 🔒 100% ("clinched").

**Key decisions:**

- Canonical pure engine in `js/playoffOdds.js` (unit-tested, 20 tests w/ seeded LCG rng);
  synced copy in `server.js` per the detectScoreSwings convention. Server-only glue:
  collectPlayerGameScores / activeRosterForOdds / fetchRemainingGamesByTeam /
  computePlayoffOddsForSeason / ensureFreshPlayoffOdds / buildPlayoffOddsSlackText.
- `sd.playoff_odds` is a derived cache written ONLY server-side (4am sync after the score
  guard settles — fresh read-modify-write so a guard-blocked compile computes from last-good
  scores; 7am scoreboard post as backstop; POST /api/seasons/:year/playoff-odds/recompute
  for the commissioner). Save handler always keeps the server copy (like score_snapshots).
  Includes `history` (≤21 daily pct snapshots) for day-over-day ▲/▼ arrows.
- UI: "Playoff %" pill column on the Pool Play Overall table + a 🔮 Playoff Odds detail
  panel (pool-win % vs wild-card %, pool gap, cut gap, projected remaining pts, games left).
  Client gates on oddsWindowForDate + !finalized_rounds.includes('PP') — after PP finalize
  the bracket is the answer. Bridged to app.js via js/index.js (oddsWindowForDate,
  formatOddsPct).
- Slack: section appended to the existing 7am scoreboard post (same window), reading the
  stored payload so Slack and UI can never disagree.
- Display caps: >99% / <1% unless mathematically locked (only PP1 pool winners get 100%;
  scores are unbounded so nobody is ever mathematically eliminated).

**Verified:** full E2E with a stubbed MLB API (fetch preload) + Slack sink + Playwright:
recompute endpoint, GET /api/seasons payload, Slack section incl. trend arrows, and the
rendered scoreboard (pills + panel). Synthetic db confirmed locked/pool/wildcard splits and
Final-game exclusion from games-remaining.

## Timezone display: server stamps are zone-less UTC; render browser-local with zone abbrev (2026-07-06)

- Server stamps swap `timestamp`/`reviewed_at` and upload-log times in UTC but strips the zone
  marker (`toISOString().replace('T',' ').slice(0,19)`), so naive `new Date()` parsing displayed
  the raw UTC clock (4–5 h ahead for Eastern). Fix (PR #342): `parseServerTimestamp` in
  `js/utils.js` interprets zone-less stamps as UTC; display converts to the **viewer's local
  timezone** (DST automatic). Storage format deliberately unchanged — old data displays right.
- Follow-up: `fmtServerTimestamp` appends the viewer's zone abbreviation (EDT/EST…) via
  `timeZoneName:'short'`, and public `GET /api/time` reports the server clock (UTC + Eastern)
  to rule clock skew in or out when a displayed time looks wrong.
- **"Still an hour off" gotcha:** a Slack post time vs. a swap-log time can legitimately differ
  when the log row is a RESUBMISSION (approve → undo → resubmit, as in the 2026-07-05 incident)
  — compare against the matching swap row, and check Slack's rendering device timezone, before
  suspecting the clock. Prod (wmmc.live) is on Render; clocks are NTP-synced.

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

## 2026-07-10 — Swap-chain grouping applied to every roster listing

- `orderWithSwapChains` (swapped-in player renders directly beneath the player he
  replaced; each chain floats by its best scorer) was extracted from the scoreboard
  detail panel in app.js into pure `js/rosterOrder.js` (bridged via js/index.js,
  unit-tested in tests/rosterOrder.test.js) and is now used by all three roster
  listings: scoreboard detail panel, My Roster per-week tables (buildPerWeekRoster),
  and the commissioner roster editor (updateCommRosterWeekView). Signature:
  `(names, scoreByPlayer, swaps, managerName, managerForEmail?)` — the last arg
  resolves legacy swap records that carry only an email.
- Live tab intentionally NOT chain-ordered: it's a single-day view, so a swapped-out
  player and his replacement almost never co-occur.
- Bridged window globals used by app.js must also be added to the globals list in
  eslint.config.js or lint fails with no-undef.
- Verification gotcha: booting the server against a scratch `db.json` REWRITES
  `managers_seed.json` from it (password-stripped mirror) — restore it with
  `git checkout -- managers_seed.json` after any local server run with fake data.

## 2026-07-12 — Mobile scoreboard: Total column restored next to Playoff %

- Bug: the mobile card layout for scoreboard rows (`mobile.css` `.mob-sbrow`)
  shows rank / name / `td:last-child` as the score slot. When the playoff-odds
  window is live, `renderOverallTable` appends a Playoff % column, so the odds
  pill became the last cell and silently displaced the Total (hidden by the
  generic `td { display:none }`). Symptom: Pool Play Overall on phones showed
  only the % pill, no scores.
- Fix: positional selectors replaced with tagged cells — app.js marks the
  Total cell `sb-mob-total` and the odds cell `sb-mob-odds`; mobile.css shows
  both (`[rank] [name…] [total] [pill]`). The class rules sit AFTER the
  `td:last-child` score-slot rule so they win the equal-specificity tie (the
  pill keeps its own 0.8rem size instead of the 1.5rem score font).
- Lesson: any new column appended conditionally to a scoreboard table breaks
  the mobile `td:last-child` score slot — tag semantic cells with classes
  instead of relying on position.
- Verified with Playwright (scratchpad-installed `playwright-core`,
  executablePath `/opt/pw-browsers/chromium`, 390×844 mobile viewport) against
  a fabricated gitignored `db.json` (schedule_dates putting today in the PP2
  Wk4–5 odds window + `playoff_odds` blob). Probed: odds absent (Total still
  renders via last-child rule), row expand/collapse, PP1/PP2 pool tables,
  desktop 7-column table — all unchanged.

## 2026-07-12 — Mobile scoreboard polish: aligned score column + odds-table headers

- Overall list: `.sb-mob-odds` now a fixed 4.25rem flex column with the pill
  stretched to 100% width and centered — uniform pill boxes mean every row's
  Total right-aligns to the same edge (was ragged because pill text widths
  varied: "🔒 100%" vs "0%").
- 🔮 Playoff Odds table on mobile: re-enabled as a real table with its thead
  (the generic `#scoreboard-content .data-table thead {display:none}` had
  left it headerless). Each th carries `<span class="th-full">` +
  `<span class="th-mob">` — desktop keeps full labels (styles.css hides
  .th-mob), mobile swaps to abbreviations (Odds / Pool W / WC / P Gap /
  C Gap / Proj / G / Sch) at 0.58rem so headers stay inside column widths.
- Fit at 390px needed: td font 0.8rem + 0.1rem side padding, manager cell
  `strong` as block with max-width 4.6rem + ellipsis (max-width only bites
  on a block inside an auto-layout table cell), smaller pills/trends inside
  the table. Overflow measured 0px; `:has(> .odds-table)` wrapper keeps
  overflow-x:auto as a fallback for narrower screens.

## 2026-07-17 — All-Star break banner + bracket-first scoreboard (PR #353)

- `getBetweenPeriodsInfo(sd)` (app.js, next to getCurrentScoringPeriod) detects a
  calendar day in the gap between two rounds' schedule_dates windows and feeds the
  champion banner: "All-Star Break — Rosters due <getPeriodDeadline> · <round> start
  <date>". PP2→QF gap = "All-Star Break"; other inter-round gaps = "Between Rounds";
  returns null inside any week / preseason / postseason / same-round gaps.
- Scoreboard-tab ordering is deliberately NOT static in index.html:
  `orderScoreboardBracket(bracketFirst)` moves #scoreboard-bracket above
  #scoreboard-content only when playoffs are the focus (active season with PP
  finalized, or historical season with bracket data). During pool play/preseason the
  scoreboard leads with the tentative bracket below. Both containers re-render
  wholesale so moving the live nodes is safe; season switches restore either order.
- `ppCollapsed` in renderActiveScoreboardTabs now includes finalized PP (not just
  playoff stats existing) so the collapsed-summary state is in the initial HTML
  during the between-periods break, not only after showActiveSeason's fixup.
- Mobile banner footer forces `white-space: nowrap` on .banner-period — any long
  period string must opt out (`.banner-period-break` wraps + hides its label span,
  since the data-short status under the title already names the break).
- Follow-up in same PR: the global #submission-warning-banner (below nav, all pages)
  now covers EVERY submission window (pp1..finals) via isPeriodWindowConfirmedOpen +
  isManagerQualifiedForPeriod + an eliminated-manager filter mirroring the card's
  "Season ended" state, and links to `goToSubmission(period)` — which clicks the
  My Roster nav tab, polls for `#period-submission-card-<period>` (render is async),
  activates the "Swaps" roster sub-tab (the cards live in #rtab-swaps, hidden by
  default), scrolls, and flashes the card. Gotcha: scrolling without switching the
  sub-tab silently no-ops — the card exists but is display:none.
- Mobile: .sub-warn-item's desktop inline-flex splits text nodes into flex items and
  stacks them in columns at 390px — mobile.css forces `display:inline` so the warning
  reads as a sentence.

## 2026-07-17 — Break-time submission warning + explicit scoreboard expand (PR after #353)

- Commissioner feedback on #353: no warning visible on 7/16 evening (QF window only
  opens the Friday before the round → midnight 7/17 local), and the collapsed Pool
  Play Scoreboard's header-arrow affordance was too subtle to discover.
- updateSubmissionWarningBanner now also warns for the UPCOMING period during a
  between-periods break (via getBetweenPeriodsInfo) even before its window opens —
  copy adds "Submissions open <date>." and the link reads "View submission page"
  until the window is open. Dropped once the period's deadline passes.
- Collapsed pool-play summary ends with a labeled pill button ("View Full Pool Play
  Scoreboard ▾", .sb-poolplay-expand-btn) that calls togglePoolPlay(); it lives
  INSIDE #sb-poolplay-summary so expand/collapse hides/restores it for free.
- Flex gotcha: .sub-warn-item is inline-flex on desktop — every text node becomes a
  flex item separated by the gap, so punctuation after a </strong> gets a stray
  leading space. Keep trailing periods inside the <strong>.

## 2026-07-20 — Banner stuck on PP2 W5 after break: calendar week now wins both ways (PR #356)

- `getCurrentScoringPeriod` starts from the latest week WITH STAT DATA; its
  calendar-week sync only capped backwards (`i < latestIdx`). When QF Week 1
  started but no QF stats had synced, the banner stayed on "Pool Play 2 —
  Week 5 of 5". Fix: if today (ET) falls inside a scheduled week, that week
  wins in both directions (`i !== latestIdx`). Also fixes which scoreboard
  section defaults open (renderScoreboardContent / renderActiveScoreboardTabs
  share the function).
- The break banner (`getBetweenPeriodsInfo`) only fires in a genuine gap
  between rounds' schedule_dates — if the QF window is drawn to include the
  break days, users see "Quarterfinals — Week 1 of 2" during the break
  instead. Verified both states with Playwright + fabricated staging-seed
  db.json (data through PP2 W5 only).
- Follow-up on same PR: the All-Star break needs NO explicit schedule entry —
  computeScheduleDates skips the ASG week by design, the break IS the gap.
  Banner (getBetweenPeriodsInfo) and daily sync (performMLBDailySync returns
  null when detectScheduleWeekForDate finds no containing week → break-week
  games never imported) both already key off the gap. New: interRoundBreak()
  helper + a "All-Star Break / Jul 13–19 / Games not scored" callout row in
  the League Info timeline (.tl-break) and commissioner schedule preview
  (.schedule-break-row), derived from the gap, PP2→QF labeled All-Star Break.

## 2026-07-21 — IL check "unverified" root cause: sd.mlb_ids coverage, not the MLB API

- First real IL swap after swap automation (Crochet, QF W1) posted "(IL status
  unverified)" despite Crochet being on the IL. Root cause: `fetchPlayerILStatus`
  bailed at `sd.mlb_ids[name]` — ids are only assigned for duplicate catalog names
  (bootstrapPlayerPools) or when the commissioner runs roster-fix, so most rostered
  players had NO id and the check failed open without ever calling the API.
  Confirmed live: player-debug showed `mlb_id: null` for "Garrett Crochet".
- Fix: unmapped names fall back to a UNIQUE normalized-name match in
  `fetchMLBPlayerCatalog(season)` (cached in-process). The fallback id is used
  transiently only — writing sd.mlb_ids stays a roster-fix/commissioner action so
  its duplicate-name ambiguity guards keep their meaning.
- Live API shape (verified in-browser on Crochet's person record,
  `?hydrate=rosterEntries`): current entry status was `code: "D60"`,
  `description: "Injured 60-Day"` — NOT "60-Day Injured List", so the old
  `/injured list/i` backstop regex could never match real data; now `/injured/i`
  ("Injured" appears only in IL statuses; codes D7/D10/D15/D60 stay primary).
- Diagnosability: unverified swaps now persist `il_reason`
  (no_mlb_id / no_roster_entry / api_error), the Slack ilNote spells it out
  ("IL status unverified — no MLB id match for player"), and all three fail
  paths console.error (before, no_mlb_id/no_roster_entry were silent and the
  reason was discarded — Render logs had nothing).
- statsapi.mlb.com is unreachable from Claude dev sandboxes (proxy 403), so the
  verified path can't be exercised in dev — test via browser/prod. The MLB API
  remains the right source; do not switch to third-party injury feeds.

## 2026-07-21 — Commissioner To-Do card (PR #365)

- New aggregated "needs your attention" card at the top of the commissioner panel
  (`#comm-todo-card`, `renderCommissionerTodo` in app.js): pending swaps + pending
  roster submissions (same definitions as the pending list; re-rendered from
  `renderPendingSwapRequests` so approve/deny updates it), player-name audit
  findings (background roster-audit, `_todoAuditCache` per page load per season,
  re-checked after cleanup apply), stale daily sync (>36h during a scheduled week,
  active season only — `todayInsideScheduledWeek` keeps the All-Star break quiet).
- Deep links: `goToCommTab(tabId, anchorId)` for sub-tab + scroll;
  `goToPoolCleanup()` opens Season Setup, expands the collapsed pool section,
  auto-runs the read-only scan, scrolls to the card.
- To add a new to-do item type: push onto `items` in `renderCommissionerTodo`
  (sync sources) or copy the cache + re-render pattern (async sources).
- Verified with Playwright + fabricated db.json, mocking /api/mlb/roster-audit and
  /api/mlb/sync-status at the network layer (statsapi unreachable from sandbox).
  Mobile note: at mobile viewports the desktop nav buttons aren't clickable via
  Playwright — drive tab switches with `document.querySelector('[data-tab=...]').click()`.

## 2026-07-22 — No login-screen flash on reload for logged-in users

**Symptom:** opening the link "logged out and back in" — a returning, still-authenticated
user saw the login screen flash before the app appeared.

**Root cause:** `#login-screen` is `display:flex` by default in CSS, and JS only hid it inside
`enterApp()`, which ran AFTER `loadData()` awaited `/api/seasons` + `/api/managers` +
`loadBannerConfig()`. On a link-open (worst on a Render cold start) that was a visible flash —
the session was never actually lost (it lives in `localStorage`), only the paint order was wrong.

**Fix (session persists, only data refreshes — no forced logout):**

- **Pre-paint (index.html head script):** if `wmmc_logged_in_email` exists, add
  `html.wmmc-has-session`, which CSS uses to hide `#login-screen` from the very first paint.
  Logged-out visitors keep the default (visible) so the form still shows instantly.
- **loadData restructured to cache-first:** new `restoreSessionFromCache()` restores the session
  and renders from cached seasons/managers synchronously BEFORE the network sync (managers +
  logged-in email are already mirrored in localStorage). The server sync then runs in the
  background and re-renders only if the data actually `changed` (diffed like `syncFromServer`).
  Idempotent — `enterApp` runs at most once (guarded on `LOGGED_IN_EMAIL`); stale saved auth is
  cleared only if the email still maps to no manager AFTER the sync (not on the first cache miss,
  which can happen on a new device before managers are cached).
- `buildSeasonSelector`'s change listener is now attached once (`_seasonSelectorListenerAttached`)
  so it can be rebuilt post-sync (to surface a brand-new season absent from the cache) without
  double-firing.

Scoring invariant untouched — this only changes WHEN we render vs. fetch (cache-first render then
background refresh is the same pattern the 45s idle poll already uses). Verified with Playwright:
75/75 login-screen samples across a reload were `display:none` (no flash); stale/invalid saved
email still falls back to login and is cleared.

## 2026-07-22 — Pool cleanup Scan→Apply infinite loop: retired phantoms re-reported forever

- Symptom: "Ronald Acuna Jr." + "Nicholas Kurtz" recurred in the audit's phantom
  bucket on every Scan; Apply changed nothing. Cause: retire = remove from pools
  (history kept by design), but roster-audit's unrostered branch reported every
  non-catalog name from extractSeasonPlayerNames — swap/roster_dates history
  resurrects the name on every scan, while roster-fix's retire is a no-op once the
  name is already out of both pools.
- Fix: pool membership is now required for the unrostered buckets in BOTH
  roster-audit and roster-fix's purge pass — "not in any pool" is the terminal
  state for a mismatched name. Its history records stay forever, by design.
- Verified by booting server.js with global.fetch stubbed for statsapi (fake
  catalog/teams JSON — statsapi is proxy-blocked in dev sandboxes, and the
  in-process \_mlbCatalogCache makes this the only way to exercise audit/fix
  here): retired phantoms no longer reported, in-pool orphan still purged,
  totals_moved [], second apply a clean no-op.

## 2026-07-28 — My Roster scoring blocks redesigned as a Pool Play → playoffs flow

**Problem.** The My Roster header was a flat `.roster-score-grid` of equal-weight stat cards
(Pool Play Total, Pool Play 1, Pool Play 2, then any playoff round with data). Nothing showed
that PP1 + PP2 _are_ the pool total, and a playoff round appeared as just another card — no
seed, no opponent, no sense of advancing or going out.

**Redesign (`renderRosterScoreFlow` + `buildRosterScoreFlow` in app.js, `.score-flow` /
`.sf-*` in styles.css + mobile.css).**

- **Pool Play panel** — combined total as the hero number with PP1/PP2 nested underneath as
  its two halves, plus a qualification chip: `Qualified · #N seed` / `Projected · #N seed`
  (before "End Pool Play") / `Missed the playoffs` / `Outside the playoff field`, with a note
  line for `Won Pool Play 1|2` / `Won both pool periods` / `Wild card`.
- **Connector + round track** — a labelled bridge flows down into QF → SF → Finals nodes,
  each with the round score, `def./lost to <opponent> <score>`, and a state:
  `won/lost/live/upcoming/locked/out` plus podium states `champion` (gold), `runner-up`
  (silver), `third` (bronze). A semifinal loser's last node becomes the 3rd Place Game.
  Eliminated in pool play → the bridge terminates at a `Season Over` pill, no track.

**Invariant.** Every score shown is still `computeRosterPeriodScores` (→ `managerWeekSubtotal`
over the date-windowed, period-scoped rosters) — unchanged numbers, verified against
`data.json`'s bracket seed totals. The _opponent's_ total and who advanced come from
`roundBreakdown` + `roundMatchupWinner` (the Playoff Bracket card's own source), so the panel
can never disagree with the bracket about a result. Nothing writes to `seasonData`.

**Gotcha worth remembering.** Historical seasons key `team_weekly` rounds as
`PP1/PP2/QF/SF/F1/F2/3PWK1/3PWK2` (not `Finals`), so the old cards silently rendered no finals
row at all for completed seasons. `FLOW_ROUND_ALIASES` rolls each node up from all its aliases
(incl. the legacy `PP1P`/`PP2P` imports).

**Verified with Playwright** against fabricated `db.json` states — mid-pool-play, PP finalized

- QF live, lost QF, missed the field, full run to champion, SF loss → 3rd place — plus the real
  `data.json` 2025 season (champion / 3rd place / lost QF / missed) at 1280px, 390px mobile, and
  dark theme.

---

## 2026-07-29 — `backfillRosterDatesFromSwaps` was clobbering effective-tomorrow drop dates

**Bug.** A manager swapped Gavin Williams → Tarik Skubal at night, after Williams' game had
started. The server did the right thing: `computeSwapEffectiveDatesServer` returned the
"already started" shape — `add_date = tomorrow`, `drop_date = today (= swap_date)` — and
`applySwapToSeason` wrote it into `roster_dates`. Then the client's
`backfillRosterDatesFromSwaps` ran on the next roster render and rewrote the drop date to
`swap_date − 1`, so the scoreboard showed Williams dropped a day early — and the silent
render-time `saveSeason` persisted the corruption.

**Cause.** The backfill predates `swap.add_date`/`swap.drop_date` existing on swap records. It
derived the whole window from `swap_date` alone (out drops the day before, in adds on the day)
and treated `drop_date === swap_date` as legacy residue to self-heal. But that is exactly the
legitimate shape of an effective-tomorrow swap — both the "team already played today" path and
a manager-scheduled future effective date (`drop_date = scheduledEff − 1`, which equals
`swap_date` when scheduled for tomorrow). The self-heal was firing on correct data. The
`add_date` fill had the same flaw (wrote `swap_date`, not `swap_date + 1`).

**Fix.** The swap record's stamped `add_date`/`drop_date` are now authoritative when present;
the `swap_date`-derived window is a fallback for legacy records only, and the raw-`swap_date`
self-heal is scoped to those. Added a narrow reverse heal (`misDerived`): when a swap carries a
stamped drop date but `roster_dates` holds exactly `swap_date − 1`, restore the stamped value —
that is the fingerprint of this bug, so already-corrupted seasons self-repair on the next
render. A commissioner's manual edit to any other date is still left alone.

**Invariant.** Roster windows still come from `roster_dates` + approved `swaps`; this makes the
two agree instead of letting a render-time repair overwrite the server's stamp. No scoring math
changed — only which drop date the windows use, and only where it was demonstrably wrong.

**Note.** `backfillRosterDatesFromSwaps` lives in `app.js`, so per the testing convention it has
no unit test. It is a good candidate to extract into `js/` (alongside `js/eligibility.js`) so
this date-window logic becomes testable.

## 2026-07-29 — Live tab: "live day" replaces the hard midnight cutoff

**Bug.** At midnight ET the Live tab went blank. `/api/mlb/live` computed `today` as the ET
calendar date and keyed everything off it — the active-week lookup, the roster `asOf` window,
`today_score`, the per-team ACTIVE/DONE/REMAINING counts, and the client's Today's Games filter.
At 00:00 all of them flipped at once, so a 10pm first pitch still in the 7th vanished and every
manager's Daily reset to 0.00 while games were literally in progress.

**Fix.** New `resolveLiveDay()` in `server.js`. A game day belongs to the date it _starts_ on
(which is already how MLB's schedule groups games — a 10:05pm ET start keeps that date to the
final out), and that day stays live through the following morning until

    rollover = min(earliest first pitch of the new calendar day − 2h, 12:00pm ET)

Two guards: a previous day with no games never holds the view over, and an unreachable MLB API
falls back to the plain calendar date rather than freezing on an unconfirmed day. Result cached
~60s and never across the rollover instant. The response now carries `live_day`, `calendar_day`,
`live_day_is_previous`, `rollover_at`, `reason`; `today` is set to the live day so every existing
downstream comparison keeps working unchanged.

**Scope decision — this is the important part.** The ask was "everywhere a today is computed"
(~35 sites). Applied only to paths that decide _which game day is displayed_: `/api/mlb/live`,
`/api/mlb/live/game/:gamePk`, and the client's Live tab (date nav, status line, games heading).
Deliberately NOT applied to anything that _stamps_ a date into the database:

- `computeSwapEffectiveDatesServer` / `fetchStartedTeamsToday` — worked example: Monday has
  games, Tuesday's first pitch is 1:05pm so rollover is 11:05am. A swap at 10am Tuesday for a
  player whose team did not play Monday would see "team not started" against Monday's slate and
  get stamped `add_date = Monday`, retroactively inserting him into completed, already-scored
  games. The calendar date correctly stamps Tuesday.
- The Google-Sheets `syncDate`, the roster/weekly backfills, the swap date-range validators,
  `ensureFreshPlayoffOdds`' odds stamp date, and the Slack post's `yesterdayET` daily high/low
  (semantically "the completed day"; a manual 3pm post would regress to a partial day).

Roster windows in the Live view _are_ evaluated as of the live day, so a swap stamped for the new
calendar date does not retroactively rewrite last night's still-on-screen scores; the new roster
takes over at the rollover.

**Invariant check.** Ran `/api/mlb/live` on `main` vs the branch against an identical stubbed MLB
slate. Control (previous day has no games, so live day == calendar date): full response
byte-identical minus the new fields. Hold-over case, at the real clock time of 00:15 ET Jul 29:
`main` reported `today=2026-07-29` with every manager at 0.00 daily (reproducing the report);
branch reported `2026-07-28` with real daily points, and `branch.total − main.total` equalled
`branch.daily` exactly for all four managers — the certified base is untouched.

**Note.** `resolveLiveDay` lives in `server.js` only, so per the testing convention it has no
committed unit test. It was verified with a scratch harness that extracted the real function
source and drove it through 17 cases (midnight, the 2h lead, the noon cap, early getaway games,
empty previous/current days, MLB down, and an EST/DST date). Not extracted to `js/` because the
server cannot import the ESM modules — that would mean a 4th hand-synced duplicate pair, which
the project already flags as a maintenance burden, and the client has no need for the logic.

## 2026-07-29 — Live board dropped a swapped-out player's points on his final rostered day

**Bug (pre-existing, surfaced while testing the live-day work).** Submit an effective-tomorrow
swap and the manager's live Daily immediately fell by the outgoing player's points for a day he
was still rostered. Measured: Daniel Kortan 78.90 → 47.90 the moment a swap stamped
`drop_date = <the day being shown>` landed. Confirmed identical on pre-live-day code
(commit `5e1dd1d`), so the live-day change did not cause it — it only widened the window in
which it is visible to include the morning hold-over.

**Cause.** `/api/mlb/live` built its roster list with `isCurrentlyRostered`, which asks _is he
rostered right now_, not _was he rostered on the day being scored_:

    return !latestDrop[p] || latestAdd[p] > latestDrop[p];

`drop_date` is inclusive — the player's last rostered, still-scoring day. That is the entire
point of the effective-tomorrow shape (`drop_date = today, add_date = tomorrow`): the outgoing
player's team already played today, so he keeps today's points, and
`syncPlayerDatesFromRosterDates` says so outright ("drop*date sets an end cutoff at the player's
last rostered day"). A player whose drop landed ON the displayed day was therefore still owed
that day, but the check excluded him — from `managerBatters`, so from `weekManagerByPlayer`, so
`continue`d out of `playerRows` entirely. The per-date guard that would have caught it,
`isDateEligibleForPlayer`, only runs \_after* the manager resolves, so it never got the chance.

**Fix.** `isRosteredForDay` keeps a player whose `latestDrop >= asOf`. Scoring is then bounded by
the player's own roster window (`gamesInRosterWindow`) rather than by `player_dates`, and
`running_score`/`stats`/`games` are computed from the windowed set so the client's per-day panel
cannot disagree with the totals. The `player_dates` dependency mattered:
`syncPlayerDatesFromRosterDates` only runs during a sync, and this endpoint is read-only, so on a
season with absent or stale entries `isDateEligibleForPlayer` falls back to the whole week and
would have over-credited a dropped player. `player_dates` still applies on top as the
commissioner's manual override.

**Impact was display-only.** The certified base came out 162 in every scenario — that is
`managerWeekSubtotal`, a different code path, untouched. Only the live Daily under-reported, and
it self-corrected at the next nightly sync. No certified total was ever wrong.

**Verified** on the hold-over board, six scenarios: no swap (78.90, byte-identical to the
pre-fix build — no regression); drop_date = displayed day (78.90, was 47.90 — fixed); dropped the
day before (47.90, correctly excluded); effective-today swap (47.90, correct); added ON the
displayed day (52.90, credited); added tomorrow (47.90, correctly excluded). Certified base 162
throughout.

## 2026-07-29 — Live tab: cache the MLB fetch layer, never the roster layer

**Problem.** `/api/mlb/live` rebuilt everything per request: the week's schedule plus one
boxscore per Live-or-Final game across the entire schedule week, sequentially (~100 round-trips
by Sunday, re-fetching immutable Final boxscores every time). Unauthenticated and uncached, so
each manager polling every 2 minutes paid the full cost alone — opening the tab was, in effect,
forcing the sync.

**Decision: cache the MLB half, recompute the scoring half.** Four layers, all over MLB-derived
data only — parsed boxscores per `gamePk` (Final = immutable, in-progress = 15s TTL), the week
schedule (shared with the box-score panel endpoint), a per-week snapshot with single-flight
dedupe + stale-while-revalidate, and a demand-driven warmer that runs only while games are live
and someone is watching.

Deliberately NOT cached: anything downstream of `readDB()`. The manager list, the date-windowed
rosters, and the certified totals are recomputed on every request. The invariant requires every
view to read managers and roster windows completely, every time; caching the finished payload
would have meant a swap approved seconds ago silently not appearing until a TTL expired. Verified
with a harness: applying a drop to `db.json` mid-run moved the manager total 123.5 → 25 and
dropped the player on the very next poll, with zero new MLB fetches.

**Cache-key subtlety.** Parsed boxscores are keyed by WMMC _display name_, so every entry is
stamped with a fingerprint of `sd.mlb_ids` — a commissioner re-pointing a player id invalidates
the parses instead of serving stats attributed to the old name.

**TTL ordering constraint (a real bug, caught in testing).** `LIVE_BOXSCORE_TTL_MS` must stay
below `LIVE_SNAPSHOT_TTL_MS`. At 45s vs 30s, every snapshot rebuild re-served the same cached
mid-game line and live scores lagged an extra TTL behind. Now 15s, with the constraint documented
at the constant.

**Note.** MLB was unreachable from the dev sandbox (network policy blocks `statsapi.mlb.com`), so
verification drove the real endpoint over HTTP against a stubbed upstream that counts calls: cold
build, 8 concurrent warm reads (zero upstream), Finals never re-fetched across a refresh cycle,
a game going Final re-fetching exactly that boxscore, and an all-Final slate costing nothing.
Per the testing convention these live in `server.js` and so have no committed unit test.

## Duplicate 7am Slack post showing "Current Period: Season" (2026-07-29)

**Symptom (commissioner screenshot, QF Week 2):** two 7:00 AM scoreboard posts in the channel.
The first was the pool-play layout — `Current Period: *Season*`, `🏆 Overall Standings`,
`_No scores recorded yet._`; the second was the correct `Quarterfinals - Week 2` bracket post.

**Diagnosis:** not a playoff-layout bug — `buildScoreboardBlocks` already drops the pool-play
frames for QF/SF/Finals (see 2026-07-15 entry). The bad post came from a process whose
`db.json` had no season data: `detectCurrentRound` finds no schedule and no scored rounds →
`currentRound = null` → label falls back to `'Season'`, `isPlayoffRound` false → pool-play
layout. Everything downstream of it agreed to post: `scoreboardAutoPostPlan` returns `{}` for
empty `schedule_dates` (documented always-post fallback) and `isWithinSyncWindow` returns true
with no dates. `last_scoreboard_post_date` can't dedupe across processes — the claim lives in
the very `db.json` that is empty. Candidate producers: the staging service (`render.yaml`:
ephemeral filesystem, reseeds from `managers_seed.json` each deploy) if a `SLACK_SCOREBOARD_
WEBHOOK_URL` was ever set on it in the Render dashboard, or a mid-deploy prod instance up
before its disk restore.

**Fix (`server.js`, display/gating only — no scoring, roster, or schedule writes):**
`hasScoreboardData(sd)` — true when the season has at least one usable `schedule_dates` entry
OR any `weekly_batting`/`weekly_pitching` row. Checked in the 7am run **before** the
`last_scoreboard_post_date` claim, so a blank instance neither posts nor burns the day's slot
and the instance holding real data still posts; `console.error` on skip. Same guard on manual
`POST /api/slack/scoreboard` (409) and `/wmmc` (ephemeral reply). OR, not AND, so opening day
(schedule set, no games played) and historical seasons (scores, no stored schedule) still post.

**Verified:** scratch harness over `hasScoreboardData` — 8/8 (missing season, `{}`,
seeded-but-blank, malformed date rows → false; opening day, mid-playoffs, pitching-only,
historical-no-schedule → true). 178/178 tests, lint + format clean. Per the testing convention
this lives in `server.js` and so has no committed unit test.

**Still to check outside the code:** whether the staging Render service has a scoreboard
webhook set in its dashboard — if so, unset it; the guard silences the post either way.

**Follow-up same session — end-of-round recaps were gated by the sync window.** Auditing the
four recap posts the commissioner expects (end of pool play, QF, SF, end of season) surfaced a
latent bug: the 7am runtime gate is `plan && isWithinSyncWindow(sd)`, and `isWithinSyncWindow`
closes the day AFTER the Finals' last day, while a recap posts the MONDAY after a round ends.
Those coincide only because every round currently ends on a Sunday (Finals end 8/30 → recap
8/31 → sync window closes 8/31, passing by exactly one day). With the Finals ending any other
weekday the championship recap is silently swallowed. Fixed by letting recaps bypass the sync
window (`plan.summaryRound || isWithinSyncWindow(sd)`) — a recap is only produced on the single
Monday `scoreboardAutoPostPlan` names for a just-ended round, so it can't post past the season.
**Verified:** day-by-day calendar sim (2026-04-01 → 09-15) on the real 2026 dates — daily posts
5/05→7/13 incl. the PP2 recap, silent ASB 7/14–7/20, QF daily from 7/21, recaps on 7/13 PP2 /
8/03 QF / 8/17 SF / 8/31 Finals, nothing after 8/31 — re-run with the Finals ending Saturday and
with 5-day weeks (all rounds ending Friday): all four recaps fire in every shape, post count
112/111/102. Before the fix the Saturday variant produced only three recaps.

## Season-opening welcome post + confirming the round cadence (2026-07-29)

**Commissioner review of the post cadence.** Walked the four requirements against the code:

1. _No post on day 1 (nobody has played)._ Already true, but incidentally: `isWithinSyncWindow`
   opens the day AFTER PP1 starts, so the season's first day was silent as a side effect of a
   stats-sync gate, not by intent. Now explicit (see below).
2. _Daily posts run through the Monday after each round ends._ Already correct.
3. _Commissioner "End Round" creates the round summary post._ Already built and untouched —
   `finalizeRound('PP')` (playoff field + QF matchups + a roast per non-qualifier),
   `dumpPlayoffLosers('QF'|'SF')` (eliminations + roasts), `crownChampionAndRoastFinals()`
   (podium + roasts). **Decision:** keep the auto 7am Monday wrap-up too. The two cover
   different things — the auto post is final scores/bracket (✅/❌, advancing footer), the
   commissioner post is who's out plus roasts. Two posts that Monday is intended, not a bug.
4. _Auto posts end the Monday after the season's last day._ Already correct (the Finals recap).

**Built: the season-opening welcome post.** Fires at 7am on the season's first day in place of
the old accidental silence. `scoreboardAutoPostPlan` returns `{ welcome: true }` when
`todayISO` equals the earliest round-window start; the 7am run posts it and skips both the
odds compute and `isWithinSyncWindow` (that window does not open until day 2 — exactly why day
1 was silent). `buildDraftFacts(db, sd)` reads `sd.initial_submissions` (canonical origin of
PP1 roster membership) and derives league-wide facts: consensus picks, biggest single-team
stack (≥3), most-similar roster pair (≥3 shared), most solo picks, field size. Unapproved
submissions count — at 7am on opening day nothing may be approved yet and this post has zero
scoring consequence. Returns null with <2 drafted rosters, and the post is then skipped.
`generateWelcomeRoastWithClaude` sends only those computed facts (explicitly told not to invent
players/stats) with `fallbackWelcomeRoast` as the static safety net, same convention as
`fallbackRoast`. **League-wide by commissioner's choice, NOT one roast per manager** — the
per-manager format belongs to eliminations, and a full slate on day 1 gets collapsed by Slack.

**Verified:** draft-facts harness 13/13 on a 12-manager fixture (consensus pick across all 12,
a 4-deep NYY stack, a 5-player twin-roster pair, an outright contrarian, plus guards: no
managers / one manager / nobody drafted → null, missing team map → no stack claim, and
determinism on re-run). Ties break by name so the same draft always renders the same post.
Calendar sim re-run: WELCOME on 5/04, daily 5/05→7/13, recaps 7/13 PP2 / 8/03 QF / 8/17 SF /
8/31 Finals, silent ASB and after 8/31 — 113 posts, and unchanged with the Finals ending
Saturday. 178/178 tests, lint + format clean. Server-only (Slack-post concern, like
`buildPlayoffMatchupsSlackText`), so no committed unit test per the testing convention.

## 2026-07-29 — A mid-week trade erased the outgoing manager's drop-day points

**Symptom (commissioner).** The 7am QF matchup post disagreed with the app: Daniel Kortan 416.4
(B 315 / P 101.4) in Slack vs 453.7 (B 315 / P 138.7) on the board — exactly Gavin Williams' QF
Week 2 start (37.35) missing, the day of his 7/28 drop. Alex Thalacker was short 12 batting points
the same morning. The Jul-28 "Best & Worst" showed Kortan at P 0 for a day his pitcher had thrown
seven innings. Separately, "Blocked a destructive season save — Anton Capria total drops 78.9"
repeated with **no matching swap anywhere in the swap log** — because it is not a swap event at all,
it is the full-season save guard refusing a write.

**Cause.** `player_dates` stores ONE scoring window per player per week; the weekly stat row is
likewise one row per player per week with a single sticky `manager`. Neither can express a player
who changes hands INSIDE a week — which is exactly what an effective-tomorrow trade does
(`drop_date = today` for the seller, `add_date = tomorrow` for the buyer, both in the same week).
`syncPlayerDatesFromRosterDates` wrote each manager's claim straight into the shared slot, so the
last one written won and the other side of the handover was discarded. `rebuildWeeklyFromDaily`
then recomputed the shared row against that single surviving window and stamped whoever currently
held the player as its `manager`. With the buyer's `{start: 7/29}` surviving, the seller's drop-day
points were erased from the database outright; with the seller's `{end: 7/28}` surviving instead,
the buyer was credited with a start he never owned. **Which one happened depended on manager key
order** — the same data scored differently on different passes, which is why a client's save could
compute a total 78.9 below the stored one and trip the ≥40-pt crater guard with nothing in the swap
log to explain it. The live view was immune (PR #381 gave `/api/mlb/live` per-manager windows), so
the app looked right while every stored/Slack number was wrong — and would have stayed wrong once
the week rolled out of live enrichment.

**Fix.** Three layers, all keyed on "the date windows are the truth, `manager` is a derived cache":

- `syncPlayerDatesFromRosterDates` merges every manager's claim to the widest window instead of
  last-writer-wins, so no day anyone rostered him is dropped from the row (and the result no longer
  depends on key order).
- `applyManagerScoreSplits` (new, run at the end of `rebuildWeeklyFromDaily` and
  `recomputeMidWeekAddScores`) writes `row.manager_scores = { manager: points }` for contested
  players only — each owner's own days, from the daily rows. `managerWeekSubtotal` (server + the
  app.js mirror) reads it, and claims a row attributed to another manager when this manager has his
  own window that week. The client is not sent daily rows, so the split has to be persisted for the
  two copies to agree.
- `findManagerForPlayerDate` (new) resolves the daily Best/Worst owner AS OF the date scored rather
  than from the current roster array, so a player's final rostered day is credited to the manager
  who actually had him. `drop_date` is inclusive, so a drop ON the date still counts that date.

**Vetted** per `SAVE_HARDENING_PLAN.md` §7 on a fixture reproducing the incident, old code vs new: no
swap and single-owner mid-week drop are byte-identical (100 / 74.7); the trade case goes from
"seller 37.35, buyer 25.3" (order A,B) or "seller 37.35, buyer 37.35" (order B,A) to a stable
seller 74.7 / buyer 25.3 in both orders; the daily high/low went from having no attribution at all to
crediting the seller. Every manager total on `tests/fixtures/staging-seed.json` is unchanged, both
directly and after a full `syncPlayerDatesFromRosterDates` + `recomputeMidWeekAddScores` pass.

**Not yet done:** the vet against the LIVE db (no prod access from this sandbox). Run the before/
after per-manager comparison there before trusting the first post-deploy numbers, and expect the
first sync after deploy to move the affected managers UP by the points that were erased — the score
guard warns on a >200-pt jump but only blocks drops, so it will not stand in the way.

## 2026-07-29 — A wrong certified total sat in Slack for three hours with nothing watching

**Incident.** The 7am QF post scored Daniel Kortan 416.4 while the app showed 453.7 — exactly Gavin
Williams' 37.35 start on 7/28, the day his effective-tomorrow trade dropped him. The Jul-28 Best &
Worst showed Kortan at P 0 the same morning, and "Blocked a destructive season save — Anton Capria
total drops 78.9" repeated three times with no swap in the log to explain it.

**What it turned out to be.** Not a scoring bug. The certified totals came from a server process
holding a `db.json` in which that manager-week scored 0, while the row it was derived from — and
every daily record behind it — said 37.35. `/api/seasons` and `/api/diag/manager`, milliseconds
apart in the same paste, returned contradictory answers from the same file. The process restarted
at 09:34 ET and every reading since agrees at 37.35 (total 3171.65 → 3209). The drift healed with
the restart; **the cause of the drift itself was never proven** — the process holding the evidence
is gone. Ruled out along the way: a code-version difference (the incident shape scores correctly on
all eight builds merged that day), duplicate/ghost rows, client-server drift (both copies of
`managerWeekSubtotal` are byte-equivalent), stale client caching (`/api/seasons` ETags the body
itself), and multiple instances (`/api/build` returned a single process id across 12 calls).

**The real defect was that nothing noticed.** Every guard in `server.js` compares a total against
ANOTHER total — the swing guard against yesterday's snapshot, the save guard against the stored
season — so a rollup that quietly stops matching the stats underneath it is invisible to all of
them. Finding it took six rounds of hand-querying the DB from a browser console.

**Fix: `auditWeeklyRollupDrift`.** Recomputes each manager-week straight from the daily rows inside
that manager's own roster windows (from `roster_dates`, period-scoped, both bounds inclusive) and
reports where the certified subtotal disagrees, naming the players responsible. Deliberately does
NOT read the weekly rows or their sticky `manager` field — those are the cache being audited. Runs
after the 4am compile and again before the 7am post (on a fresh read, since a blocked compile
leaves rejected scores in memory), alerts via `postSlack` once per distinct finding-set per
process, and is exposed on demand at `GET /api/diag/rollup-audit`. Detection only. Commissioner
overrides (`drop_locked` / `manual_fields`) are exempt — a hand-set number is supposed to differ.

On this incident it would have posted at 4am: _"Daniel Kortan QF|Week 2: certified 0 vs 37.35 from
the daily rows (under by 37.35) — Gavin Williams -37.35."_

**Verified** on the incident shape (rollup loses the row → flagged, names the player), a stale
rollup score on a full-week player (flagged), a ghost row crediting a player the manager no longer
rosters (flagged, +50), a commissioner override (correctly silent), and both seasons of
`tests/fixtures/staging-seed.json` (silent — no false positives). Kept in `server.js` with no `js/`
copy and no unit test, matching the live-day precedent: the client has no use for it and the
project already carries enough hand-synced duplicate pairs.

**Side note worth keeping.** The per-manager window scoring added in the same PR makes the
certified number self-healing for exactly the class of player that broke here: any player whose
roster window covers only part of a week is now scored from the daily rows rather than from the
stored rollup, so a bad rollup score for him can no longer reach a total.

## 2026-07-30 — The drift audit's first alert was a false positive (effective-tomorrow adds)

**Alert.** `auditWeeklyRollupDrift` posted at 4am, one day after it shipped: Chris Bentivegna
PP2|Week 4 certified 227.55 vs 298.55 (Michael Harris II -71) and Jamie Rogers PP2|Week 5 certified
296.6 vs 316.7 (Tyler Phillips -20.1). Both still drifting on demand via
`GET /api/diag/rollup-audit`, both attributing the whole gap to one player certified at exactly 0.

**The scoreboard was right; the audit was wrong.** Each flagged player had a single `roster_dates`
entry holding an `add_date` **one day after the end of the week key it was filed under** — Harris
`PP2|Week 4` (ends 07-05) add 07-06, Phillips `PP2|Week 5` (ends 07-12) add 07-13. That is the
effective-tomorrow swap submitted on a week's **final day**: the add takes effect the next week, the
entry lands in the submission week's bucket, and `player_in` is already in that week's roster array.
Bentivegna's roster history confirms it — Harris first appears in the `PP2|Week 4` array, absent from
every earlier week. The stored `weekly_score` was 0 with `override: false`, so the compile agreed
with the read path; only the audit dissented. Nobody was owed points and no data repair was needed.

**Why only these two of twelve played weeks.** `managerWeekRosterWindows` collected the latest
add/drop constrained to `add_date <= weekEnd`, so an add dated after the week was **discarded**,
leaving the player with no date events at all — which dropped him into the roster-array fallback and
credited him the **whole week** he never played. An add after `weekEnd` is not missing information;
it is positive evidence of absence. Fixed by collecting those players into `joinedAfterWeek` in the
same pass and excluding them from the fallback only (the in-range branches are untouched, so a
player with any in-range add/drop is unaffected). Also corrected the alert's own remediation line:
it told the commissioner to re-run **Sync Now**, which only touches the current week
(`/api/mlb/sync-current` → `resolveWeeksForCatchUp`) and therefore cannot repair a finished one —
**Rebuild Totals** (`/api/mlb/rebuild-weeklies`) is the button that recompiles past weeks.

**Accepted tradeoff, decided deliberately.** If an `add_date` after a week's end is a _typo_ and the
player really was rostered, the audit now stays silent where it used to fire. Certified already
scores that player 0 either way, so the audit was reporting the downstream consequence of a bad
roster date, not a rollup-vs-daily disagreement — and bad roster dates belong to `ghost-audit` /
`roster-audit` / the swap log. Keeping the old behavior would mean every effective-tomorrow swap
landing on a week boundary posts a false drift alert, which trains the commissioner to ignore the
one alert that exists to be trusted.

**Verified** with a harness that extracts the real functions out of both the patched and the
committed `server.js` and runs them side by side: both live shapes flip firing → silent; the 7/29
incident shape (in-range add, rollup lost the row) still fires at -30; a no-dates player with a
zeroed rollup still fires (fallback preserved); a drop dated _after_ the week still fires; a
`manual_fields` override stays silent; a mid-week add whose rollup matches stays silent; both seasons
of `tests/fixtures/staging-seed.json` unchanged. Per-manager totals vet per the core invariant: all
8 fixture managers byte-identical before and after (`managerWeekSubtotal` is not touched — the change
is confined to detection-only code). 187 unit tests, lint, and format all pass.

**Worth remembering for the next one of these.** `weekly_rows[].manager` in `/api/mlb/player-debug`
is stamped from _current_ rosters by `rebuild-weeklies`, so a player shows his present manager on
every historical week — it is NOT evidence he was rostered then, and it made both flagged players
look like season-long holdings at first read. Ownership comes from `roster_dates` + the roster
arrays, exactly as the core invariant says.

## 2026-07-30 — The pool-play scoreboard shell came back, because the guard checked a proxy

**Incident.** The duplicate 7am post PR #383 was supposed to stop showed up again during QF Week 2:
the real Quarterfinal bracket post, plus a second one reading "Current Period: _Season_" with the
pool-play "Overall Standings — _No scores recorded yet._" section. PR #383's `hasScoreboardData`
was deployed at the time.

**Why the guard missed it.** It tested two _proxies_ for "can this post mean anything" — does the
season have any `schedule_dates` entry with start+end, OR any `weekly_batting`/`weekly_pitching`
row — while the thing that actually decides the post's shape is whether a **round** resolves.
Those are not the same question, and at least three states satisfy the proxies while still
resolving to no round:

- a schedule whose weeks are all still in the future (`detectCurrentRound` matches neither "contains
  today" nor "most recently completed", so it returns null) with no scores yet;
- `weekly_pitching` rows restored but not `weekly_batting` — the in-builder round fallback read the
  batting table only;
- and the inverse hazard: `schedule_dates` wiped (a known failure mode here — see the boot audit)
  with only pool-play rows left, which resolves to PP2 and reinstates the pool-play frames
  mid-playoffs rather than falling back to "Season".

**Fix: ask the real question, once, in one place.** New `resolveScoreboardRound(sd)` is now the only
answer to "which period does a scoreboard post for this season cover":
schedule → latest round with stat rows in _either_ table → null. It also returns null when the
bracket is locked (`confirmed_seeding.qualifierNames`) and pool play is all this process can see —
pool play is over and we cannot name the playoff round, so silence beats stale framing. An explicit
`opts.summaryRound` wrap-up bypasses it and still renders its pool-play frames.

`buildScoreboardBlocks` frames the post from it and returns the resolved `round`;
`hasScoreboardData` is now a one-line delegation to it, so the pre-flight check and the post that
goes out cannot disagree. And the guard moved to the send-time chokepoint: **`postScoreboardSlack`
throws on a null round**, so the 7am auto-post, the manual commissioner post, `/wmmc`, and any
future caller all inherit it — the upstream checks now only exist to produce a better error (409 /
ephemeral) and to avoid consuming the day's `last_scoreboard_post_date` slot.

**Verified.** The eight-state table (healthy QF, blank instance, blank season, all-future schedule,
pitching-only, bracket-locked-pool-play-only, historical season with scores and no schedule, opening
day) resolves as intended — the three new states are the ones that changed, the healthy/opening-day/
historical ones are untouched. Before/after render of the real `/api/slack/command` path against
`tests/fixtures/staging-seed.json` is byte-identical. No scoring path is touched: this only gates
and frames the Slack post, and reads no managers, roster windows, or swaps.

## 2026-07-30 — Eliminated managers were still being tagged on Live box scores

**Symptom.** With the bracket past the Quarterfinals, opening a game card on the Live tab showed
the red manager pill next to players belonging to managers who were already out — Austin's name
sitting on a Rangers batter in a round Austin isn't playing in. The Live standings above it
(correctly) didn't list him at all, so the two halves of the same tab disagreed.

**Cause.** The two halves resolved "who rosters this player" from different sources.
`/api/mlb/live` derives rosters from the `roster_dates` windows scoped to the current period
(`periodStartForRound`) — the invariant's source of truth. `/api/mlb/live/game/:gamePk` instead
called `findManagerForPlayerWeek(...) || findManagerForPlayer(...)`, both of which read the
`sd.rosters` ARRAYS. Those arrays are a derived cache, and `findManagerForPlayer` in particular
scans **every week of the season**, so any player who was ever on an eliminated manager's roster
kept resolving to them forever. `wasDroppedBeforeWeek` didn't catch it: the player was never
_dropped_, his manager just stopped playing.

**Fix.** Extracted the live endpoint's period-scoped derivation verbatim into
`buildWeekRostersFromDates(sd, round, week, asOf)` and pointed the box score at it, deleting both
array fallbacks there. Eliminated managers now fall out for the right structural reason rather than
via a bracket-participant list: they have no add inside the current period, so no player resolves to
them. Same helper on both sides means the box-score tag can never name a manager the standings
aren't showing. When the live day falls outside any schedule week there is no roster to flag
against, so nothing is tagged — which matches `/api/mlb/live` returning empty managers for that
same state.

**Verified.** The extraction is byte-identical to the block it replaced (comment/indent-insensitive
diff of the pre-change block vs. the helper body), so `/api/mlb/live` — and every score it feeds —
is untouched; no manager totals move. A synthetic SF-week fixture with an eliminated manager holding
a QF roster in both `roster_dates` and `sd.rosters` confirms the three cases: the eliminated
manager's player is untagged in SF, the active manager's player still tags, and asking for QF itself
still returns the eliminated manager (history intact, only the current-round view changed).
209 tests pass; lint and format clean.

## 2026-07-31 — The duplicate 7am post was never in the code; it was a second webhook holder

**Symptom.** Third consecutive morning of two 7am posts: the pool-play shell ("Current Period:
_Season_", "🏆 Overall Standings — _No scores recorded yet._") stacked above the real Quarterfinals
post. Slack groups consecutive app messages under one 7:00 AM header, so it reads as one post with a
duplicated intro — the commissioner reasonably reported it as a rendering bug. It is two messages.

**The guards were right.** Extracted `resolveScoreboardRound` / `hasScoreboardData` from HEAD and ran
them over every state that can render that frame — no season, `{}`, schedule wiped, blank date
strings, bracket-locked-pool-only — all resolve null, and `postScoreboardSlack` throws on null. A
process running current `main` **cannot** emit that post. So the sender was running something else.

**Elimination, in order.** Prod: one `[Scoreboard] Daily scoreboard posted successfully` in the 7am
logs, on the post-#392 build, with a disk and Upstash (so it holds real data and posts the correct
QF layout). Staging: `origin/staging` is 118 commits behind (7/20, predates both guards) and so
_could_ render the shell, but its Render env has no Slack vars at all — `scheduleScoreboardPost`
returns at the webhook check. Render has exactly two services and zero env groups. Claude Code
sandboxes: the agent proxy blocks `hooks.slack.com` outright (`CONNECT tunnel failed, 403`), so no
web/phone session could post even holding the URL. The commissioner's Windows laptop: no Node
process, and WSL is not installed.

**What actually found it.** The posts render as "WMMC Scoreboard" while the Slack app is named
"PlusPlus", and `postSlack` never sends a `username` — a modern app-managed webhook always posts
under the app's own identity and cannot be renamed per-hook. Therefore the webhooks were **legacy
Incoming WebHook custom integrations** (workspace-level, each with its own configurable name/icon),
which is why the app's own Incoming Webhooks page read "Off" with no URLs. **Three sessions searched
the wrong inventory.** The real list lives at
`<workspace>.slack.com/apps/manage/custom-integrations`. It held exactly one webhook posting as
"WMMC Scoreboard" — so the second sender was using **prod's own URL**, copied out at some point;
nothing about it was discoverable from the code, and there was no third webhook to find.

**Resolution (operational).** New from-scratch Slack app "WMMC" with two app-managed webhooks
(`#greatelmotontine` scoreboard, `#wmmcnotis` swaps), `/wmmc` moved onto it (Socket Mode had to be
turned off for the Request URL field to appear, and the old app's `/wmmc` had to be deleted first —
slash command names are unique per workspace), new signing secret, all three env vars updated on
Render, both legacy integrations revoked. Verified before revoking: `/wmmc` renders, and
`POST /api/slack/scoreboard` (no UI button exists for it — call it from the console via `apiFetch`)
posts to the scoreboard channel.

**Code change (the only one this incident justified).** `SLACK_SCOREBOARD_WEBHOOK_URL` no longer
falls back to `SLACK_WEBHOOK_URL`. That fallback meant a process configured only for swap
notifications silently became a scoreboard poster into the swaps channel — wrong output, and one
more way for a stray instance to reach the league. Unset now disables the auto-post with a log line
that says why. Prod sets both explicitly, so nothing changes there. Touches no managers, roster
windows, swaps, or scoring — no totals move.

**For next time.** When a Slack post cannot be explained by any code path, stop reading code and
inventory the webhooks — **including `apps/manage/custom-integrations`**, not just the app's page. A
display name that does not match the app name is the tell that a legacy integration is in play. And
treat a webhook URL as a credential: this one leaked far enough to outlive three fix attempts.

**Amendment (same day) — the sender was never identified, and that is where this entry ends.**
The webhook is revoked, so whatever it is now gets a 404 from Slack and reaches nobody; the hunt
was stopped deliberately, not completed. Leads exhausted, so the next session does not re-run them:
production (posts once, on the current build, holds real data), staging (no Slack env vars at all),
the account-wide Render list (exactly two services, zero env groups), the commissioner's Windows
laptop (no Node process, WSL not installed), Claude Code sandboxes (the agent proxy blocks
`hooks.slack.com` outright — `CONNECT tunnel failed, 403` — so no web/phone session can post even
holding the URL), Heroku (the account is empty, and free dynos were discontinued in Nov 2022, so a
free app there has been off for years), and the Google Sheets Apps Script triggers (deleted as a
precaution; the gsheets path is a dormant fallback the MLB API replaced).

What is known about it: it ran `server.js` from a **7/05–7/28** checkout (the post carries the
header link added 2026-07-05 but lacks the 7/29 guard), against an empty `db.json` (no seasons →
`detectCurrentRound` → null), with **no** Upstash credentials (with them it would have restored real
data and posted a correct scoreboard), on the same `getNextEasternHour(7)` timer, holding the
legacy scoreboard webhook — i.e. production's own URL, copied out at some point. An equally good
fit that was never ruled out: nothing was running the app at all, and a scheduled job somewhere was
replaying one captured payload, which is indistinguishable from the Slack side because the shell
post is byte-identical every morning.

**If duplicates ever return, start from "find the sender", not from the code.** The scoreboard
guards have now been verified correct twice.

## "End Quarterfinals" 409'd, didn't stick, and carried rosters into SF Week 1 (2026-08-03)

**Symptom (commissioner, live).** Clicking **End Quarterfinals** raised the "Your view was out of
date, so that change was not saved" alert and reloaded; the button stayed active. A Slack
`:no_entry: Blocked a destructive season save (2026)` fired listing six managers with
`SF|Week 1 roster shrank (B 4→0, P 3→0)`. No round-end Slack post with roasts, and the commissioner
submission panel still read **Semifinals — pending finalization**.

**Root cause (one click, two full-season saves built from two different snapshots).**
`finalizeRound()` took its own `getSeasons()` deep copy, then called `advancePlayers()`, which took
a **second independent copy**, mutated it and saved it — after which `finalizeRound` saved its own
now-stale first copy on top. The second payload lacked the SF Week 1 rosters the first had just
written, so it rewound the local cache and hit the server as a destructive/stale save. Because
`finalized_rounds` rode on that rejected payload, **QF was never finalized** — which is the single
cause of all three reported symptoms: `getSFParticipants()` returns null without `finalized_rounds`
including `'QF'` (→ "pending finalization"), and the follow-up **"Advance SF Winners & Dump QF Loser
Rosters"** button — the thing that generates QF roasts and posts the round-end Slack — only renders
once QF is finalized. (The roasts visible on eliminated managers' pages were the older Pool Play
ones.)

**Second bug, same click.** Advancing into SF Week 1 (index 12) is a **period boundary**, where the
CORE SCORING INVARIANT forbids carry-forward — the new period is owned by its submissions. It wrote
prior-round rosters, unbacked by `roster_dates`, for every manager holding a QF Week 2 roster,
QF losers included. `finalizeRound` did this for QF→SF (12) and SF→Finals (14); the PP→QF (10) call
was already dead code behind an early `return`.

**Third bug, the very next step.** `dumpPlayoffLosers()` removed the losers' next-round submissions
by mutating `sd.period_submissions` and saving the season — but the per-year save treats
`initial_submissions`/`period_submissions` as **server-authoritative** and unconditionally restores
the stored copy, so every "dump" left the losers' SF/Finals submissions intact. Now goes through
`removeSubmissionRemote()` (the atomic DELETE endpoint), then re-reads before saving `eliminated`/
`losers_dumped`.

**Fix (app.js only).** `advancePlayers` split into pure mutator `applyAdvancePlayers(sd, weekIndex)`

- a thin `window.advancePlayers` wrapper — **the caller owns the save**, so one click writes exactly
  one payload. `applyAdvancePlayers` refuses period-boundary weeks (new client-side
  `isPeriodBoundaryWeek`, mirror of the server's), and the Advance Players button is replaced on those
  weeks by a note explaining the round comes from submissions. `finalizeRound` is now `async`, mutates
  one snapshot, does one awaited save, and only re-renders once the save is confirmed — a rejected
  save leaves the button live instead of showing a finalization the server refused. Its unused
  `weekIndex` param is gone (all four call sites updated).

**Verified E2E** (Playwright, synthetic 8-manager season re-dated so QF Week 2 ended yesterday).
_Before the fix_ the drive reproduced production exactly: two POSTs (`200` then `409`), the verbatim
"out of date" alert, QF unfinalized, no dump button, and 8 unbacked `SF|Week 1` rosters + 64
zero-stat rows. _After_: single `POST -> 200`, zero alerts, `finalized_rounds ["PP","QF"]`,
`advanced_weeks []`, zero SF rosters/rows, dump button present and issuing real submission DELETEs,
and **all 8 per-manager totals unchanged (delta 0)** — the §7 invariant vetting.

**Repair for a season already polluted:** `POST /api/seasons/:year/purge-orphan-boundary-rosters`
(dry-run first) clears boundary-week rosters not backed by a submission. Validated against the
damaged fixture: cleared 8, `moved_totals: []`. A leftover `advanced_weeks: [12]` is cosmetic once
the button is hidden at boundaries. Re-clicking End Quarterfinals afterwards then succeeds cleanly.

## Round-end Slack post rebuilt: results, margin ordering, matchup-aware roasts, Friday reminder (2026-08-03)

Commissioner's verdict on the first working QF round-end post: "it worked, but it's not great."
Five changes, all in `server.js` (Slack composition only — no scoring math touched).

**1. Playoff rounds now open with the actual results.** The `summary` block was hardcoded
PP-only, so a QF/SF post went straight into roasts and never said who won or who advanced.
It now calls the existing `buildPlayoffMatchupsSlackText(sd, round, { final: true })` — the same
builder the daily scoreboard uses, so the two posts can never disagree about a score. Renders
every matchup with both totals, the B/P split, ✅/❌, and an "Advancing to the Semifinals: …"
footer.

**2. Eliminations are ordered by margin of defeat, narrowest first.** Alphabetical order buried
the heartbreaker wherever the alphabet put it. Matchups are resolved ONCE into `matchupByManager`
and reused for sorting, the per-manager line, and roast generation. PP (no head-to-head) and any
unresolvable matchup fall back to alphabetical, sorted last.

**3. Each roast carries its head-to-head line** — `lost to X 1,182.4–1,274.4 (by 92)`. Formatted
with the same 1dp/thousands-separator formatter as the results block, so one number never appears
twice in a message wearing two different faces.

**4. Roasts can talk about the game.** The elimination prompt never mentioned the opponent, score,
or margin — only a list of bad players. New `computeMatchupNarrativeForRoast(sd, round, manager,
opponent)` walks the round's scored days accumulating both sides from `computeDailyHighLow`'s
`managerTotals` (newly returned; the top/bottom lists are sliced to 3 and unusable for this), and
derives lead changes, whether the loser ever led, their biggest lead, when they lost it for good,
and wire-to-wire status. Fed to the prompt with explicit steers for the three interesting shapes
(blown lead / never led / margin ≤ 25). `fallbackRoast` got a matching head-to-head bank for the
no-API-key path. **Cross-check that matters:** the day-walk's final totals matched
`playoffMatchupResultForRoast`'s weekly-rollup scores exactly for all four managers — two
independent derivations agreeing.

**5. Submission instructions moved to the Friday post.** A round ends Sunday and the next
deadline is 8 days later, so the full walkthrough was read a week before it could be acted on.
`buildNextRoundInstructions` (round-keyed) became `buildSubmissionInstructionsFor` (upcoming-round
keyed) plus `buildSubmissionWindowBlock(sd, todayISO)`, which fires only when today is
`roundStart − 3` (the same definition `getPeriodOpenDate` already uses for "window opens") and
appends to the daily scoreboard blocks. The round-end post keeps only
`buildDeadlineReminderLine` — one `:alarm_clock:` line with the Monday first pitch, rendered via
the shared `periodLockLabel`, which now emits a real zone abbreviation (`8:00 PM EDT`) instead of
a hardcoded `ET` that was wrong for half the season.

**Verified E2E** with a Slack sink + Playwright on a synthetic season whose QF just ended, using
daily rows and weekly rollups derived from the same deltas so they can't disagree. Confirmed:
results block + advancement footer, margin order (92 → 133.1 → 196.45 → 562.85), head-to-head
lines, the reminder line, the Friday block present on `start−3` and absent on every other day, and
one narrative per manager including a genuine blown-lead case (led 2 of 14 days, up 28.1, lost it
July 22). Per-manager totals unchanged.

**Gotcha for the next fixture:** `buildPlayoffMatchupsSlackText` and `playoffMatchupResultForRoast`
both return null without `sd.confirmed_seeding`, which is written by "End Pool Play" in the UI —
a hand-built fixture that only sets `finalized_rounds: ['PP']` silently degrades to the old
alphabetical, matchup-less post. Drive End Pool Play through the UI rather than faking it.

## Fallback roast bank: doubled, no-repeat within/across periods, article fix (2026-08-03)

Follow-up to the round-end post rebuild, same PR (#396).

**Grammar.** `roastRoundLabel` returns the round WITH its article (`'the Quarterfinals'`) because
43 of its 54 uses read `across/in/of ${roundLabel}`. But 11 templates put a possessive right
before it — `${manager}'s ${roundLabel}` — producing "Casey Curve's the Quarterfinals". Fixed with
a second `roastRoundLabelBare()` used only in those 11 positions; stripping the article globally
would have broken the 43 correct ones instead.

**Doubled the banks.** core 20→40, betrayal 15→30, dayBank 15→30, head-to-head 7→17 (max bank
57→110). The dayBank additions respect that bank's standing rule: `best_day`/`worst_day` are
picked independently by score, NOT by date, so no template may imply chronology
(no then/before/after/rally).

**No repeated joke in a period, or across back-to-back periods.** Every template now carries a
stable id (`sub-bank:index`), persisted as `sd.roasts[mgr].template_id`.
`recentFallbackTemplateIds(sd, round)` collects ids used in this round and the previous one; the
`/roasts/slack` loop seeds a live set from it and grows it as it picks, because the batch isn't
written until after the loop.

Two design points that mattered:

- **h2h is four fixed sub-banks** (`h2h-base/-wire/-lead/-close`), not one conditionally-appended
  array. With one array, index 2 means a different joke to a wire-to-wire loser than to a
  blown-lead one — ids must be stable across managers or the exclusion is meaningless.
- **Probe forward from the natural slot; do NOT pick out of a filtered array.** The first version
  did `bank.filter(...)` then `seed % pool.length`, which renumbers every index — so storing one
  manager's roast silently reshuffled everyone else's, and picks changed on every regenerate even
  with zero collisions. Now: seed → natural slot → walk forward to the first non-excluded id. A
  manager keeps the same joke run after run, and only a real collision moves them, by one slot.

**Return-shape change:** `fallbackRoast`/`fallbackRoastForOutcome`/`generateRoastWithClaude` now
return `{ text, templateId }` (templateId null when Claude wrote it, and for champion/third, which
are one-per-season and can't collide). Three call sites updated.

**Verified** with no `ANTHROPIC_API_KEY` so every roast came from the bank: 4 QF managers got 4
distinct ids; two identical regenerate runs produced byte-identical assignments (stability); and
planting `core:6` on a Pool Play roast moved Drew Dinger — whose natural QF pick is `core:6` — to
`core:7` while leaving the other three untouched (minimal displacement, cross-period exclusion).

## Roster-page elimination roasts: round-by-round sections, league ranks, and a negative-points bug (2026-08-03)

**What was wrong.** The page context under the Hall of Shame banner read as trivia, not a roast:

- "Getting here" was one line (seed + pedigree) with no supporting numbers.
- A playoff exit collapsed the whole tournament into a single head-to-head line — a Semifinals
  loser got no Pool Play or Quarterfinals section at all.
- Every point total was unanchored. "Rafael Devers shows up (123 pts)" says nothing about whether
  123 was good.
- Close losses read exactly like blowouts (`closeCall = margin <= 20` tweaked one QF template).
- The day-by-day line collided two numbers with nothing between them: "the bottom 3 4 times".
- **A batter was shown at -12.7 pts for a single game, which is arithmetically impossible.**

**The negative-points bug (the real one).** Daily rows store `delta` = today's cumulative line
minus the previous snapshot's. When MLB revises an earlier box score downward, the cumulative
total drops and the difference lands on whatever date the correction happened to sync — producing
a negative delta. Every batting weight in `SCORING` is positive (1B/2B/3B/HR/R/RBI/SB/BB), so a
negative batting _game_ cannot exist; it is always a correction to an earlier one. Pitchers _can_
legitimately go negative (H/ER/BB carry negative weights), so the guard is **the negative stat,
not the negative score**: `isCorrectionDelta` = any component < 0.

Fixed in `countsAsGameDelta` (= `hadGameDelta && !isCorrectionDelta`), used by both
`computeDailyHighLow` (which only filtered all-zero deltas before, so the daily Slack "worst
player" post had the same defect) and `buildManagerPerformanceForRoast`. All-zero deltas are
excluded from day totals too, so a date on which nobody played stops registering as a 0-pt
"worst day". **No score moves** — weekly and season totals are computed from the weekly rows, not
from these filters. Verified on a synthetic QF: without the guard the worst "game" was
`-22 pts {1b:-2, hr:-1, r:-1, rbi:-2}`; with it, a real 2-pt game (7 rows dropped, 1 correction +
6 no-plays).

**New: league-wide role ranks.** `computeRoleRanksForRoast(sd, managerNames, round)` ranks every
(manager, player) roster SLOT by round total, split by role, using the same ownership rule and
weekly rows as `buildManagerPerformanceForRoast`, so a rank can never disagree with the points the
roast credits. Ties share a rank. It also ranks managers by batting and by pitching total for the
round (managers with 0 in both are excluded, so an eliminated manager doesn't pad everyone's
rank). This is what produces "6th of 45 hitters couldn't cover the 45th" and "2nd of 9 for
pitching, 9th of 9 for hitting". Fed to the Claude prompt too (`roastPromptRankLines`).

**New: one section per round played.** `buildRoundBreakdownsForRoast` walks `ROAST_ROUND_ORDER`
up to the elimination round and emits a stage per round the manager actually played (skipping
rounds with no rostered players). `buildRoastPageContext` renders each as its own paragraph with a
`[[Label]]` marker; app.js pulls the marker into a `.roast-context-label` chip and renders
unmarked paragraphs exactly as before, so roasts stored before this change still render.

**Margin drives intensity in every round.** `roastMarginTier` (heartbreak ≤10, close ≤25,
competitive ≤60, clear ≤150, blowout) selects the result sentence for each playoff section and the
"missed it by" sentence for a Pool Play exit. Heartbreak/close losses additionally get the
cruellest line available: "One 22-point game — one — out of X, who managed 13.4 across the entire
round, and Joey is still playing."

Two things that had to be threaded through: rounds the manager _won_ get their own roster-sentence
bank (calling the Finals winner's #30 hitter "closer to the truth" is just false), and `outcome`
now reaches `buildRoastPageContext` so champion/3rd-place pages don't get "and it was all for
nothing" framing.

**Perf.** `collectRoastInputs` gathers everything for one manager and takes a per-request cache;
the combined `/roasts/slack` loop shares one, so each round's league rank table is built once
rather than once per eliminated manager. Earlier stages skip the `computeDailyHighLow`-per-date
sweep (`skipDayExtremes`) — only the elimination round shows a day-by-day tally.

**Also fixed in the joke bank** (the text that goes to Slack): seven `dayBank` templates presented
best/worst day numbers without saying which was which ("boils down to two numbers: 87.6 points on
Jul 26, and 9 on Jul 22"), or were pure recitation with no joke at all. Rewritten to label both
and land a beat. Template _ids_ are index-based and unchanged, so the no-repeat exclusion is
unaffected.

**Verified** end-to-end against a synthetic 9-manager season through the real
`/api/seasons/:year/generate-roast` endpoint (no `ANTHROPIC_API_KEY`, so the bank wrote the jokes):
QF exit, PP exit, Finals champion, and Finals runner-up all render correct sections; screenshotted
the banner at 1280px and 390px.

## Article bug had a SECOND class, and production has no ANTHROPIC_API_KEY (2026-08-03)

Ran the regenerate-only probe against live 2026 QF roasts. Two findings.

**1. The possessive fix was incomplete.** `roastRoundLabelBare` covered `${manager}'s ${roundLabel}`,
but `roundLabel` is also used **attributively** — modifying a following noun, or after a determiner —
where the article is equally wrong:

- `a ${perf.total}-point ${roundLabel} team total` → "a 442.75-point **the Quarterfinals** team total"
- `this ${roundLabel} matchup` → "this **the Quarterfinals** matchup"
- `The ${roundLabel} highlight package` → "**The the Quarterfinals** highlight package"

17 more spots fixed (11 `-point`, 2 possessive, 2 `this…matchup`, 2 `The…`). Two of the possessive
ones were **my own regression**: I ran the possessive swap first and then added 50 new templates,
some of which reintroduced the pattern. Order of operations matters — do the mechanical fix LAST,
or re-run it after adding content.

**Classification rule for the next person:** article-free before a noun or after a determiner
(`a 442-point Quarterfinals team total`, `this Quarterfinals matchup`); article kept after a
preposition or verb (`across the Quarterfinals`, `spent the Quarterfinals waiting`, `Time of death:
the Quarterfinals`). 96 usages read fine, 22 flagged by heuristic, 17 genuinely broken — the
heuristic over-flags `surviving/end/same/you ${roundLabel}`, so classify by eye, don't bulk-replace.

**2. Production is NOT using Claude for roasts.** All four live QF roasts came back verbatim from
the static bank ("Breaking news out of the WMMC newsroom…" is `core:11`). So `ANTHROPIC_API_KEY`
is unset (or failing) on the Render service — `render.yaml` declares it `sync: false`, i.e. set by
hand in the dashboard, and it evidently never was. I had earlier asserted the live roasts "clearly
read as Claude-written"; that was an assumption, and it was wrong.

Consequence: the entire matchup-aware prompt work (PR #396) is dormant in production — the prompt
is only reached when the key exists. The fallback bank's own head-to-head templates DO fire, but
only when the seeded pick lands in `h2h-*`, which is 17 of 110 slots. Setting the key in the Render
dashboard is the single lever that turns the feature on.

## Roast repair buttons generalized to every round (2026-08-03)

**Gap.** "Regenerate Roasts" and "Regenerate & Repost Roasts to Slack" existed only on the Pool
Play block (`i === 9`). Once QF/SF/Finals were dumped the admin panel showed a static "loser
rosters dumped" line and nothing else — no way to refresh roasts after the bank or the
page-context builder changed, short of a browser-console API call. The PP buttons exist for
exactly that scenario, so the fix is generalization, not new capability.

`regeneratePoolPlayRoastsOnly` / `repostPoolPlayRoasts` → `regenerateRoundRoasts(round)` /
`repostRoundRoasts(round)`, plus `roastRepairToolsHtml(round)` rendered under PP (when
finalized) and under QF/SF/Finals (when dumped).

**The design decision worth keeping: read who was eliminated from stored state, not from the
bracket.** The PP versions recomputed non-qualifiers via `getQFQualifiers`. A repair action must
not do that — by the time you're reposting, the round is long finalized and `sd.eliminated` may
carry commissioner corrections the recomputed bracket would silently overwrite. `eliminatedInRound`
reads `sd.eliminated` (authoritative; every finalize/dump path writes it) and folds in stored
roasts as a fallback for the window where a dump wrote roasts but the eliminated map didn't land.

**Finals podium round-trips through `roast.outcome`.** `podiumRolesFromRoasts` reads champion /
runner_up / third back off the stored roasts rather than re-deriving the bracket winner, so a
repost can never crown someone different from the original post. Verified: seeding the four Finals
roasts and reading back gives podium = [champion, runner_up, third] and Hall of Shame = [4th]
only — the same split `crownChampionAndRoastFinals` produces.

Regeneration stays **sequential** — each `generate-roast` is a read-modify-write of `db.json`.

**Verified** by driving the real admin panel with Playwright against a fixture with PP+QF
finalized and dumped: both button pairs render with the right round bound, `regenerateRoundRoasts('QF')`
rewrote exactly the 4 QF-eliminated managers with the new sectioned page context and correct
round/outcome, and `repostRoundRoasts('QF')` failed gracefully ("Slack webhook not configured")
rather than throwing.

## Day-by-day tally replaced with a per-round summary (2026-08-03)

**Why.** The "Day by day" section counted how often the manager finished top-3/bottom-3 leaguewide
across the round. Two problems: it was a bare tally with no dates or scores attached, and it existed
only for the elimination round because the leaguewide sweep was too expensive to run per round.

**Replaced with, in EVERY round section:** the manager's own three best and three worst scoring days
(date + score), and a top-3/bottom-3 leaderboard per position carrying each player's round total,
league rank among same-role players, and how many days they were the best on that roster at that
position.

**The perf win that made it possible.** Everything above derives from this manager's own weekly and
daily rows, which `buildManagerPerformanceForRoast` already walks. The old tally needed
`computeDailyHighLow` per date — a leaguewide sweep — which is why it was gated behind
`skipDayExtremes` for earlier rounds. Deleting `computeRoundDayExtremesForRoast` removed the only
caller of `computeDailyHighLow` in the roast path entirely: the roast context is now both richer
and cheaper, and `skipDayExtremes` is gone. `computeDailyHighLow`'s `bottomPlayersByScore` field
existed solely for that tally and had no other consumer, so it went too.

**Three things that only showed up in real output:**

- `days_led` is printed for the top-3 only. On a five-hitter roster over thirty days everybody leads
  sometimes, so "best on 6 days" sitting next to a name filed under `Worst:` reads as praise and
  muddles the contrast.
- The two lists overlap on short rosters (top 3 and bottom 3 of five players share the middle one).
  The bottom list drops any name already in the top list rather than printing it twice — which is
  why a five-man roster shows three best and two worst, not three and three.
- Same for days: with ≤5 scored days the best and worst lists are the same days in opposite order,
  so the worst list is suppressed.

**Formatting.** With top-3 AND bottom-3 per position, a round section became a wall of text. Section
bits are now joined with `\n` (blank line still separates sections), and the roster page renders
single newlines as `<br>` — result, split, days, hitters, pitchers each get their own line.
`rosterSentence` was deleted: it named one player per role, which the leaderboard now supersedes,
and keeping both printed the same names twice.

The prompt gets the new signal too — `roastPromptRankLines` now carries days-led per player and the
best/worst scoring days, so the joke can tell "carried the team" from "had one loud afternoon".

**Verified** end to end through the real endpoint on a synthetic season (QF exit, PP exit, Finals
champion), plus screenshots at 1280px and 390px.

## Round summary became three tables; roasts are now server-authoritative on save (2026-08-03)

**Change.** The per-round best/worst summary was two dense prose sentences. Replaced with three
tables per round section, laid out side by side: **Scoring days** (the manager's own best 3 and
worst 3, with each day's rank among all managers that date), **Top performers** (top 3 hitters +
top 3 pitchers, with rank among same-role players and days-led), and **Bottom performers** (bottom
3 of each). Every number carries a rank.

**Day ranks needed a leaguewide sweep back — but a cheap one.** Ranking a day against all managers
needs every manager's total for that date. Rather than reinstate `computeDailyHighLow` per date,
`computeRoleRanksForRoast` now also emits `dayRanks`, built from the daily rows in the same pass,
with the **same ownership rule and correction guard** as the per-manager totals it already
computes. That matters: reusing `computeDailyHighLow` would have ranked a day using a different
attribution path than the score printed next to it. And because the rank table is memoized per
round in the request cache, it is built once per round for the whole combined post, not once per
manager.

**Structured payload, not HTML in a string.** `buildRoastPageContext` now returns
`{ text, tables }`; `tables` is keyed by the same `[[Section label]]` the text uses, and is stored
as `roast.page_tables`. The roster page builds the DOM and escapes every cell, so a player name out
of the MLB feed can never inject markup. Roasts stored before this render text-only — tables are
additive, never required.

**The save bug this surfaced.** `sd.roasts` was union-merged on the full-season save: the server's
copy filled in only managers the incoming payload did not mention. But the client **never writes**
`sd.roasts` — three read sites in app.js, zero writes — so a roast in a payload is always a stale
echo of something the server wrote. The union-merge therefore let a full-season save carrying a
pre-regeneration roast silently roll that manager back: same manager, older text, and any field
added since (`page_tables`) quietly dropped. Now the server's copy always wins per manager. This is
the exact class of bug CLAUDE.md's "never wipe a server-authoritative field from a client payload"
warns about, and it was live before tables made it visible.

**Layout.** `.roast-tables` is `repeat(auto-fit, minmax(210px, 1fr))` rather than a fixed 3-column
grid, so a round with only two tables (a roster too short to have distinct bottom performers) still
fills the row instead of leaving a hole. Verified stacking cleanly at 390px with no horizontal
overflow.

## Round sections became three narrative lines over the tables (2026-08-03)

**Shape.** Each round section is now exactly three prose lines, then its three tables: **(1) what
happened** — the result or where they finished, tiered by margin; **(2) how it played out** — the
day-by-day story; **(3) where the points came from and who to blame**. The tables stopped being a
summary of the prose and became the data view under it.

**Line 2 needed a per-round matchup narrative, which used to be elimination-round only.**
`computeMatchupNarrativeForRoast` walked the round's dates calling `computeDailyHighLow` per date —
the sweep that made it too expensive to run for every round. Rewrote it to read the `dayRanks`
table `computeRoleRanksForRoast` already builds (every manager's total for every date, same
ownership rule, same correction guard). Signature changed from `(sd, round, manager, opponent)` to
`(dayRanks, manager, opponent)`. Now every round the manager played gets its own story — blown
lead, wire-to-wire, lead changed N times — and it costs one table build per round for a whole
combined post. That is the third `computeDailyHighLow` caller removed from the roast path.

Pool Play has no single opponent, so line 2 there is the shape of the round instead, counted off
the same table: how often this roster was the league's best or worst team on a day.

**Two overstatements the fixture caught, both worth keeping in mind for future template work:**

- "A roster with two settings and no dial between them" fired on 3-best/3-worst out of 30 days,
  which is not two settings, it is mediocrity. The day-shape line now branches on the _ratio_
  (best≫worst, worst≫best, neither, all-zero) and only uses the two-settings framing when the
  counts really are comparable and non-zero.
- "X did the opposite" fired on a roster whose weakest link was 15th of 27 leaguewide — middling,
  not catastrophic. Now gated on `rank > of * 0.5`, with a "nobody was a disaster" bank for strong
  rosters. Overstating a number the reader can check in the table underneath is the fastest way to
  make the whole section untrustworthy.

Repeated phrasings ("carried what there was to carry", "did the opposite") are now seeded banks via
the existing `pick`, so adjacent sections and adjacent managers don't read as a form letter.

## The roast API call could 500 instead of falling back (2026-08-03)

**Symptom.** Regenerating live QF roasts, one manager came back `500 {"error":"Failed to generate
roast"}` while the other seven succeeded. Same manager had succeeded minutes earlier in a different
run, so it was transient, not data-dependent.

**Cause.** `generateRoastWithClaude` handled `!resp.ok` — an HTTP error status falls back to the
static bank — but the `fetch` itself was unguarded. A network-level rejection (socket reset, DNS
blip, TLS failure) throws, and the throw goes straight past the fallback, out of the function, and
into the route's `catch`, which returns 500 and stores nothing. `generateWelcomeRoast` two thousand
lines down wraps the identical call in try/catch, so this was an inconsistency rather than a
decision.

**Why it mattered more than a one-off 500.** In the combined `/roasts/slack` loop the throw is
caught per manager and falls back to **the existing stored roast**. So a blip mid-repost silently
puts a manager's _previous_ roast into the new Slack post, and nothing surfaces it — you would only
notice by reading all of them against what the console printed.

**Fix.** `try`/`catch` around the fetch, plus `AbortSignal.timeout(ROAST_API_TIMEOUT_MS)` (30s) —
the combined post generates sequentially because each call is a read-modify-write of `db.json`, so
one hung connection stalls every manager behind it. Also guarded `resp.json()` (a truncated body is
the same class of failure) and `resp.text()` in the error path.

**Verified by before/after against a dead endpoint.** Pointed the call at `https://127.0.0.1:9`
(discard port) in both `origin/main`'s server.js and the fixed one, with a dummy API key so the
code path is reached:

- before: `HTTP 500`, `{"error":"Failed to generate roast"}`, nothing stored.
- after: `HTTP 200`, static-bank roast stored with `template_id=day:27`, `page_tables` intact, and
  `Anthropic API call failed for Anton Capria - TypeError fetch failed` in the log.

Note for future testing in this container: `/etc/hosts` already pins `api.anthropic.com`, and Node's
fetch goes through the agent proxy regardless, so neither a hosts override nor `NO_PROXY` will
simulate an unreachable API. Patching the URL is the reliable way.

---

## 2026-08-05 — Live tab boxscores scrolled inside their column while the page had empty gutters

**Symptom.** Desktop Live tab: the expanded per-game boxscores (two 12-column tables side by side)
each had their own horizontal scrollbar, while the page itself showed wide empty margins.

**Two independent causes.**

1. `.live-box-table th, .live-box-table td { padding: 0.25rem 0.4rem }` never applied. Specificity:
   `.data-table thead th` / `.data-table tbody td` are (0,1,2) and beat a bare `.live-box-table th`
   at (0,1,1), so every cell kept the generic **0.75rem** side padding — 24 columns × 24px ≈ 288px
   of padding per table. `.mgr-detail-panel .data-table thead th` (0,2,2) already did this right;
   the boxscore rule was just written at the wrong specificity. Fixed by matching the
   `thead th` / `tbody td` shape, plus `letter-spacing: 0` on the headers.
2. `main { max-width: 1200px }` applies to every tab, but Live is the only one that renders two
   full boxscores side by side. Raised to 1560px above 1280px viewport width, scoped with
   `main:has(> #live.active)` (`:has()` is already used elsewhere in `styles.css`).

Also dropped `white-space: nowrap` on the first column only — the numeric columns stay nowrap and
tabular, so the player-name column is the one that absorbs any remaining squeeze by wrapping.

**Measured** with a static harness reproducing `renderLiveBoxscoreHTML`'s markup against the real
`styles.css`, comparing `scrollWidth - clientWidth` per `.table-wrapper`:

| viewport | before (worst overflow) | after |
| -------- | ----------------------- | ----- |
| 1280     | 164px                   | 0     |
| 1650     | 164px                   | 0     |
| 1920     | 164px                   | 0     |

Zero overflow on the whole Live tab (standings, expanded manager detail, boxscores) from 1000px up.
Mobile is untouched — the widening is behind `min-width: 1280px`, and 12-column tables still scroll
on a phone, which is out of scope here.

## The Hypothetical Zone, and two MLB sync bugs it uncovered (2026-08-05)

**What shipped.** A read-only "What If" sandbox tab, in five PRs: #403 engine + Scoring Lab,
#404 Roster Lab, #405 Player Explorer, #406 round-scoped standings + mobile nav, #408 stat-coverage
diagnostic. Then two sync fixes it surfaced: #411 and #413.

**Design decisions to preserve.**

1. _The sandbox derives only the DELTA._
   `hypothetical = realScore + (score(rows, scenarioTable) − score(rows, realTable))`. The stored
   score is authoritative and never recomputed, so the empty scenario reproduces the live scoreboard
   **by construction**, and a commissioner-adjusted row (whose stored score does not match its raw
   line) cancels out of the subtraction. Do not "simplify" this into a from-scratch recompute.
2. _The engine does not reimplement roster windows._ It consumes resolved slots from
   `managerWeekSubtotal`, which owns the core invariant. One source of truth for "who was rostered
   when".
3. _Seeding and bracket rules live in `js/seeding.js` and `js/bracket.js`_, shared by the real
   bracket and the sandbox, so a hypothetical can never disagree with reality about the rules.
   `app.js`'s `computePoolPlaySeeding` now delegates to `seedFromPeriodTotals`.
4. _The sandbox never invents data._ A manager promoted into a round they never played carries
   their last real roster forward, labelled as an assumption. A round nobody has played does not
   resolve at all (`roundHasStats`) — otherwise an unplayed semifinal scores 0–0 for everyone and
   crowns a champion on seed alone.

**Bug 1 — a July game counted in a May week (#411).** A postponed game keeps its **originally
scheduled** date in the MLB schedule response. Once the makeup is played it reads `Final`, so
`fetchMLBGames` — which took the date from the wrapper the game arrived in — accepted it and stamped
it with the rainout date. gamePk 823062, played 2026-07-07, was counted as a 2026-05-05 start,
inflating one pitcher's PP1 Week 1 line from 6 IP to 13 IP and ~34 points to his manager. Fixed by
taking `game.officialDate` and dropping games outside the requested range. MLB lists such games under
**both** dates, so the makeup is still scored correctly in its real week — verified against live data
before shipping. `gamesFromSchedule` (Live tab) had the same flaw and was fixed too.

**Bug 2 — late stat corrections were never picked up (#413).** `resolveWeeksForCatchUp` only
re-syncs the current week and the one before it, within the same phase, so a correction landing on a
week that has since closed is invisible. Three were sitting in the 2026 season: +5, +2 and −0.6.
`sweepStatCorrections` now walks every completed week on the Wednesday run, syncs each into a clone,
measures, and adopts only that week's rows. **It refuses movement over `MLB_CORRECTION_MAX_SWING`
(default 15) and Slack-alerts instead** — a real correction is small; a big swing is a bug, which is
exactly how bug 1 presented.

**Gotchas.**

- **`/api/mlb/compare` is NOT a scoring prediction.** Its `mlb_total` comes from `enrichBatting`,
  which scores the whole week **unclipped**, while stored scores are clipped to each player's roster
  window. A mid-week swap shows there as a large phantom difference a real re-sync would never
  produce. It sent this investigation down the wrong path twice. Use `POST /api/mlb/resync-dryrun`,
  which runs the real `performMLBSync` against a deep clone and persists nothing.
- **`MLB_API_BASE` env var** overrides the MLB API base URL — point it at a local stub to exercise
  sync paths with no network. Defaults to the real API.
- `js/hypothetical.js` uses `\0` **escapes** in Map keys. They were once raw NUL bytes, which made
  git treat the file as binary and hide its diffs.

**Done.** PP1 was re-synced week by week (after #411 was deployed, and only once all five weeks
dry-ran clean), restoring the daily rows and the batting `so`/`lob`/`abs` that round had been missing.
Worth confirming once in a new session — PP1 strikeouts should now be non-zero, and the What If
Scoring Lab should move Pool Play 1 when SO is given a value:

```js
const sd = (await fetch('/api/seasons').then((x) => x.json()))['2026'];
console.log(
  'PP1 SO:',
  (sd.weekly_batting || []).filter((r) => r.round === 'PP1').reduce((a, r) => a + (r.so || 0), 0)
);
```

**Open.** Mobile Roster Lab stacks its two columns, so actual-vs-hypothetical takes a scroll.

**Next tasks (requested, not started).** _Both were built in PR #415 — see the entry below,
which also corrects task 2's diagnosis. Kept here as written for the record._

1. _Slack prompt only when a round outcome changes._ On the Wednesday run **after a round ends**,
   post to Slack **only if** corrections would change a round _outcome_ — a pool-play period winner,
   a wildcard/qualifier, or a playoff matchup winner. Stay silent when only point totals move.
   Sketch: capture the outcome before and after `sweepStatCorrections` and compare. The rules exist
   in `js/seeding.js` and `js/bracket.js`, but those are ESM and **`server.js` cannot import them** —
   check first whether `server.js` already has equivalent seeding logic (playoff odds / Slack
   scoreboard) before adding a third copy, and if a copy is unavoidable add it to the "must stay in
   sync" list in CLAUDE.md.

2. _The scoreboard scaling limit._ At ~1,340 batters / 16k weekly rows the scoreboard never finishes
   rendering — over three minutes, measured. This is **pre-existing**: it reproduces on `7087e0a`,
   before any What If work, so nothing in this session caused it. Cause: `managerWeekSubtotal` runs
   256× per render (16 weeks × 8 managers × 2 types), each call scanning every weekly row. Likely fix
   is to index the weekly rows by `manager|round|week` once per render instead of re-scanning per
   call. It touches the core scoring path, so it needs a before/after per-manager totals comparison —
   `POST /api/mlb/resync-dryrun` is not the right tool there (it re-syncs); compare
   `captureScoreSnapshot` output before and after the refactor instead. Worth measuring the real
   season's row count first to see how close production actually is to the wall.

---

## 2026-08-05 — The two queued "next tasks", and one of them was chasing the wrong thing

Both came off the task list in the entry directly above. That list sat on an unmerged branch
(PR #414) while this work happened, so it was invisible from a fresh clone — worth remembering that
a task queued only in an open PR is a task nobody will find.

### 1. The corrections sweep now posts only when a RESULT changed

**The rule.** A stat correction that moves a manager 2.4 points is not news. One that overturns a
pool-play period winner, who qualifies (or the seed order the bracket pairs off), or a playoff
matchup winner, is. `captureRoundOutcomes` snapshots those three things, `diffRoundOutcomes` says
what moved, and the Wednesday sweep posts only when the list is non-empty. Point totals moving is
the expected weekly case and stays in the log.

**No third copy of the rules, which was the whole risk.** `server.js` already owns both halves:
`currentQualification` (the playoff-odds engine) for pool winners + qualifiers, and
`computePlayoffPairs` (the Slack matchup post) for who played whom and who won. Both re-used
verbatim, so an alert can never disagree with the bracket it describes. `js/seeding.js` /
`js/bracket.js` are the client's ESM copies and `server.js` cannot import them — the temptation
to paste a third implementation is exactly what CLAUDE.md warns about. The only edit to existing
logic was adding `pp1LeaderByPool` next to `currentQualification`'s existing `pp2LeaderByPool` so
the message can name the pool.

**A shape change worth knowing about.** `sweepStatCorrections` now adopts accepted weeks into a
`target` season — the live `sd` when applying, a throwaway deep clone on a dry run — and returns
`{ results, outcomeChanges }` rather than a bare array (two callers: the 4am cron and
`POST /api/mlb/apply-corrections`). That is what lets `dryRun` answer "would this change a result?"
without the live season seeing a row.

**How it was verified, and the reusable recipe.** A stub MLB Stats API behind `MLB_API_BASE`
(serve `/api/v1/schedule` + `/api/v1/game/:id/boxscore` out of a mutable plan; a "stat correction"
is then just a plan edit between two sweeps), the staging seed for managers/pools/rosters, and
`DB_PATH` pointed at a scratch db.json. Per-manager pool totals compared before and after each
sweep:

| run                                       | applied | outcome_changes                      |
| ----------------------------------------- | ------- | ------------------------------------ |
| +10 to a manager 20 pts off the pool lead | 1 week  | `[]` — silent, the case that matters |
| +30 over three weeks, passing the leader  | 2 weeks | PP1 winner flip + seed-order change  |
| the same as a dry run                     | 0 (dry) | reported, db.json totals unchanged   |

One extra HR = +10 pts, comfortably under the 15-pt refusal ceiling, so the ceiling still fires
independently. Gotcha for the fixture: give the managers distinct baselines. With everyone tied,
the tie-break — not the correction — decides every pool, and the "silent" case cannot be tested.

### 2. The scoreboard scaling limit: the stated cause was wrong

**The claim was `managerWeekSubtotal` x 256 per render, and ~3 minutes at ~1,340 batters / 16k
weekly rows. It is not.** Measured with `scripts/measure-scoreboard.js` (added in the same PR —
loads the real `app.js` in a VM sandbox, times the pass, prints per-manager totals, runs against a
real `db.json` or a synthesized season of any size):

| season                         | rows   | before | after  |
| ------------------------------ | ------ | ------ | ------ |
| 1340 bat / 550 pit / 512 swaps | 30,240 | 287 ms | 134 ms |
| 1340 bat / 700 pit / no swaps  | 32,640 | 292 ms | 112 ms |
| 2680 bat / 900 pit             | 57,280 | 467 ms | 176 ms |

Under half a second at nearly twice production scale, and **linear** in row count — the curve was
checked at 8k / 13k / 24k / 45k rows. Swap volume barely moves it either. So the scoring pass
cannot be a three-minute render, and the next session should not spend more time on it. **The real
suspect is the payload, not the loop:** `GET /api/seasons` still ships `score_snapshots` and the
daily rows, re-downloaded on every tab switch (see the open follow-up further up this file, and
the localStorage-quota incident it came from). Multi-MB JSON over a phone connection, parsed on
the main thread, is a much better fit for "never finishes". Measure the real `db.json` first:
`node scripts/measure-scoreboard.js --db db.json --season 2026`.

**The optimization shipped anyway, because it is free.** Weekly rows are now bucketed by
`round|week` (legacy `PP1P`/`PP2P` folded onto the parent) and by manager, cached in a WeakMap on
the rows array. 2–2.7x on the pass. It is a lookup change, not a scoring change: bucket order is
the array's own order, so `weekManagerRows` / `allWeekRows` / `finalRows` / `detailOut` all come
out identical. Proven three ways — identical per-manager totals and qualifier list across five
season shapes; identical call-for-call (including `detailOut`) on a fixture built for the
semantics a synthetic season cannot produce (legacy `PP1P` rounds, null-manager rows, contested
`manager_scores` splits, duplicate ghost rows, a drop-and-re-add, a swap-in evidenced only by a
stat row, a pending swap that must be ignored); and a byte-identical rendered scoreboard in a real
browser against a real server.

**Cache invalidation is the part to be careful with.** Replacing `sd.weekly_batting` gets a fresh
index for free (WeakMap key), and a `push` changes `length` and rebuilds. The one mutation neither
catches is a row replaced **in place at the same length** — `editStat` does exactly that, and calls
`invalidateWeeklyRowIndex`. Any new code that swaps a weekly row in situ must do the same.

**Still open.** Mobile Roster Lab stacks its two columns (from #414's list). And the seasons
payload trim above, which is now the most likely lead on scoreboard slowness.

## 2026-08-05 — The slow scoreboard was `GET /api/seasons`, not the scoring pass

Follow-on to the entry above, which ruled out `managerWeekSubtotal`. Measuring the **live** app
found the real cost. Console, logged in, on production:

| measurement       | value                                        |
| ----------------- | -------------------------------------------- |
| waiting on server | **784 ms** cold, **753 ms** on a repeat      |
| downloading       | 26 ms / 18 ms                                |
| wire              | 320 KB gzipped (2,850 KB raw) — gzip is fine |
| `JSON.parse`      | 8 ms                                         |
| weekly rows       | 10,568 — not the 16k the old note claimed    |

**The repeat being just as slow was the whole diagnosis.** `sendJsonRevalidated` derived the ETag
_from_ the serialized body, so the server parsed the entire `db.json` (daily rows included — far
more than it sends), serialized ~3 MB, SHA-1'd it and gzipped it, and only then decided to return 304. A 304 cost the same as a 200.

**Why that reads as "never finishes" rather than "slow".** All of it is synchronous, so requests do
not overlap — they queue behind whichever one holds the event loop. The first measurement of that
same request was **3,598 ms**, roughly four requests' worth of pile-up during page load. Add other
managers, or the 4am sync holding the loop, and the tab just sits there.

**Fix (#416).** Build the payload once and hold it, keyed on a fingerprint of `db.json`:
`dbWriteCounter` (bumped in `writeDB`, which every in-process write funnels through) plus the
file's `mtime`+`size` (for anything that replaces the file from outside — the **startup Upstash
restore writes `DB_FILE` directly**, bypassing `writeDB`; so does a manual repair). One `statSync`
per request instead of a multi-megabyte read. `sendJsonRevalidated` split into `buildJsonPayload` +
`sendPreparedJson`; gzip is now lazy and retained.

Measured old-vs-new on a 10,240-row / 10.6 MB fixture: `GET` 283 ms → 83 ms, **304 410 ms → 2 ms**,
payload byte-identical. Both invalidation paths tested explicitly (a swap through the API; a
`db.json` edited underneath the process), plus two reads with no write between them returning the
same ETag — otherwise a "cache" that silently rebuilds every time would have passed.

**Not yet reproduced: the three-minute figure itself.** It came from the same note whose diagnosis
was already wrong, so treat the number as unverified. The queueing explanation fits, but it is an
inference.

### NEXT TASK — cache the parsed `db.json` in `readDB()`

`readDB()` still does a synchronous read + `JSON.parse` of the whole ~10 MB `db.json` on **every
request to every endpoint** — 112 call sites. #416 only stopped `GET /api/seasons` paying it.
Caching it would speed up everything, but the blast radius is much wider than the payload cache.

Steps, in order:

1. **Confirm the payload cache actually landed in production first.** Re-run the resource-timing
   console block (`performance.getEntriesByName(origin + '/api/seasons')`, reporting
   `responseStart - requestStart`). Expect waiting-on-server to collapse to single-digit ms. If the
   scoreboard still stalls after that, stop and re-diagnose — do not build this on an assumption.
2. **Measure `readDB()` in isolation** before changing it: log timing around the read+parse for a
   few requests on production data. It should be ~200–400 ms at 10 MB. If it is not the remaining
   hot spot, this task is not worth its risk.
3. **The hazard that makes this different from #416.** 83 of the call sites do
   `const db = readDB()` and then **mutate the returned object** before calling `writeDB(db)`. A
   naive cache that hands every caller the _same_ object turns those into shared mutable state: a
   half-finished mutation in one handler becomes visible to the next request, and an abandoned one
   (a validation failure that returns early without writing) silently poisons the cache. Options,
   roughly in increasing order of safety: return a structured clone per call (cheaper than a
   re-parse, but not free); split into `readDBForWrite()` (uncached, as today) vs `readDBCached()`
   (shared, read-only) and migrate read-only endpoints one at a time; or freeze the cached object
   so a mutation throws loudly instead of corrupting. **Prefer the split** — it keeps every write
   path on today's exact semantics, so the risk is confined to endpoints that only read.
4. **Invalidate identically to #416** — reuse `dbFingerprint()` rather than inventing a second
   scheme. The Upstash-restore-writes-the-file-directly case is already handled there.
5. **Vet with per-manager totals**, since read paths feed scoring:
   `node scripts/measure-scoreboard.js --db db.json --season 2026 --json before.json`, then the
   same after, and diff. Byte-identical or it is not this change.

**Also still open:** mobile Roster Lab stacks its two columns (from the #414 list).

## 2026-08-05 — Redundancy audit: one real boot-time bug, one drift, and a scope correction

A QA sweep for duplicated code, dead code and unnecessary guards. Baseline was healthier than
expected — 331 tests green, lint and format clean, and **zero orphan top-level functions** in
either monolith (289 defs in `app.js`, 241 in `server.js`, every one reachable). The problems were
duplication and one hot spot. Four PRs: #419, #420, #421, #423.

### The one that mattered: `backfillWmmcQS` ran on every boot (#419)

It was the **only one of the six startup migrations without a db flag**. Every restart — every
Render deploy, every spin-down wake — it ran over every season, including completed ones, and boot
then `writeDB`'d unconditionally.

The cost is the same O(rows × daily) shape already fixed for the scoreboard in #417:
`recomputeAllWeeklyScores` calls `computeEffectiveBattingScore` per weekly row, and each of those
`.filter()`s the whole daily array. Benchmarked at this league's row counts (10,568 weekly rows):

| weekly rows | daily rows | time     |
| ----------- | ---------- | -------- |
| 10,500      | 40,000     | 3,530 ms |
| 10,500      | 80,000     | 6,529 ms |

Batting half only; pitching repeats it. **~7–13s of synchronous, event-loop-blocking work per
boot.** Worth holding next to the still-unreproduced "three-minute scoreboard" figure — the
queueing story fits, though this is boot-time, not per-request, so it is at most a partial answer.

**The proof it was safe to stop is worth reusing.** Boot the OLD code twice against the same
scratch db: the second boot printed no `[WMMC-QS]` correction line at all. It was already
correcting nothing — it just paid the full recompute to discover that. Then all four combinations
(old×2, new×2) produced byte-identical per-manager totals.

**What deliberately stayed on every boot:** `dedupeWeeklyRows`. It is O(n) and still earns its
place — the Sunday auto-advance tests for an existing row with `b.manager === m.name`, while a
duplicate is any second row for the same `round|week|player`, so a row on file under a different
manager (or `null`) can still produce one. **Latent bug, not fixed here:** that existence check
should probably be manager-agnostic. Left alone because it changes roster behavior and did not
belong in a cleanup PR.

### `currentQualification` had already drifted (#420)

`server.js` gained `pp1LeaderByPool` in #415; the canonical, unit-tested `js/playoffOdds.js` copy
never got it. Exactly the hazard CLAUDE.md warns about — **the tests were certifying a copy that
was not the one running**, so parity read green while it was not.

Every other documented pair was genuinely in sync (checked by normalizing and comparing bodies:
`SCORING`, `SEASON_SCHEDULE`, `detectScoreSwings`, `checkSwapLimit`, and the whole odds engine).
Two undocumented duplicates are now on the CLAUDE.md list: `ROUND_LABELS`, and
`SEASON_SCHEDULE`'s one _permitted_ difference (client entries carry `label`, the server's do not)
so a future parity check does not "fix" it.

### Duplication deleted (#421)

`escapeHtml` ≡ `esc` (33 sites). `HOF_ROUND_LABELS` ≡ `ROUND_LABELS_FOR_ROAST`, character-identical
1,400 lines apart → `BRACKET_STAGE_LABELS`. The bracket grid's nested `matchupHTML` ≡
`renderMatchupResultCard`. And **`periodStartForRound` was a third implementation** beside
`js/eligibility.js` and `server.js` — the period scoping the core invariant names by function.

Gotcha for anyone doing this again: `app.js` is a **classic script**, so a top-level
`function periodStartForRound` _assigns to_ `window.periodStartForRound` and clobbers the module's
export. The local adapter has to be renamed (`periodStartForSeason`), not kept.

Also stripped 13 dead entries from the `js/index.js` window bridge. They stay exported from their
modules — tests need them, and `resolveBracket` is imported by `js/hypothetical.js` — only the
bridge drops them. `eslint.config.js`'s `projectGlobals` caught the newly-bridged name immediately;
that list is doing real work, keep it accurate.

### The scope correction, which is the lesson

I opened by estimating **~330 lines of retirable one-shot migration code**. That was wrong, and
this file already said why. The 2026-06 cleanup that deleted `repairMissingSwapRecords`,
`repairMissingRosterChains` and `repairBentivegnaPitcherRoster` (−524 lines) carries an explicit
**"Kept"** list right beside it. The operative rule is:

> **delete hardcoded, incident-specific one-shots; keep generic repairs and structural migrations.**

Applying that honestly, only **two** qualified (#423, −140 lines): `purgeGhostHerreraFromJoey`
(hardcoded to one manager and one player; merged to prod 2026-06-07 with a verified settled total)
and `purgeBoundaryAutoAdvance` (repairs damage from a boundary auto-advance `isPeriodBoundaryWeek`
now structurally prevents). `repairCarryForwardRosters` — the largest at 139 lines, and the one
that inflated my estimate most — **is not a one-shot at all**: no flag, runs every boot by design.

Check this file's "Kept" list before proposing to retire anything in that family.

### Reusable: verifying a boot-path change is score-neutral

`scripts/measure-scoreboard.js` needs a db with **daily** rows to be meaningful — the staging seed
ships weekly rows only, which makes `computeEffectiveBattingScore` return `null` and the whole
recompute a no-op, so a broken change would pass. Synthesize daily rows by splitting each weekly
row's counting stats across the week's dates first.

Then boot the real server with `DB_PATH` at a scratch file, `MLB_API_BASE` at a dead port
(bootstrap fails fast and logs "continuing"), and a free `PORT`. **A boot rewrites
`managers_seed.json`** via the googleEmail backfill — `git checkout --` it before committing.

### Still open

- The `readDB()` cache (the task queued above this entry) — unchanged by any of this.
- Boot does **13** `readDB()` calls, each a full parse of the whole db.
- The Sunday auto-advance's manager-scoped duplicate check, noted above.
- Mobile Roster Lab stacks its two columns (from the #414 list).

**Follow-up: welcome post moved to an hour before first pitch (2026-07-29).** Commissioner
confirmed staging has no `SLACK_SCOREBOARD_WEBHOOK_URL`, so the duplicate blank post in the
QF Week 2 screenshot did NOT come from staging — source still unidentified (most likely a
prod instance that came up before its `/var/data` disk mounted, since `readDB()` returns
`{seasons:{}}` in that case). The #383 guard makes it harmless either way, and its
`console.error` now names the offending process the next time it happens.

7am was the wrong hour for a post nobody can act on. `scheduleSeasonWelcomePost(reason)` now
arms a timer for `firstPitch - 1h` using `fetchFirstPitchToday` (earliest `gameDate` on the
day's MLB schedule, same field `fetchStartedTeamsToday` reads). Called from the 7am run AND
at boot — the timer can sit for ~6 hours and an in-memory `setTimeout` does not survive a
Render restart, so without the boot re-arm one restart on opening day loses the post for the
season. No-ops on every other day. Falls back to posting immediately when the MLB lookup
fails or the slate is empty. Separate `db.last_welcome_post_date` claim, written AFTER a
successful post (opposite of the daily scoreboard's claim-first): a post that failed because
nobody had drafted yet gets retried every 30 min, bounded because the function no-ops once
the ET date rolls past opening day.

**Verified:** 8/8 timing harness driving the real function with a stubbed clock/db/MLB —
7:05pm first pitch → armed 11h05m out; 1:10pm day game → 5h10m; restart at 8pm after a 7pm
first pitch → post now, not never; MLB fetch throws → post now; empty slate → post now;
non-opening day → nothing armed; already-claimed day → nothing armed. 178/178, lint + format
clean.

## 2026-08-05 — Open-PR triage: #386 refreshed, #374 retired in favor of a focused round gate

**Context.** Two PRs had been open since late July and had fallen 135 (#386) and 167 (#374)
commits behind `main`. Both were CI-green, but against week-old bases.

**#386 (welcome post an hour before first pitch) — refreshed, still valid.** `server.js` merged
cleanly; only `MEMORY.md` (append-only) conflicted. Nothing on `main` duplicates it —
`scheduleSeasonWelcomePost` was absent — and the wiring survived the merge intact (7am job, boot
re-arm, retry, `last_welcome_post_date` claim). 333/333.

**#374 (Live tab eliminated-manager ownership) — ~80% superseded, closed.** `main` had
independently reimplemented the core, better: `buildWeekRostersFromDates` replaced #374's
`buildWeekRosterIndex` with the same date-window derivation **plus** scheduled-swap handling and
`rosterWindowByPlayer`, and `resolveLiveDay()` replaced its hand-rolled ET date. The headline bug
(box score tagging players to knocked-out managers via the all-weeks `findManagerForPlayer`
fallback) is already fixed on `main`: in any non-PP1 period a manager with no current-period add
fails `isRosteredForDay`, so eliminated managers resolve to nobody. All five `server.js` conflict
hunks resolved to "take main's side."

**What was NOT covered, and is what shipped instead.** `/api/mlb/daily` built `allManagers` from
`Object.keys(sd.rosters)` with no elimination filter. That list never consults roster windows, so
`main`'s period scoping doesn't reach it — eliminated managers still rendered as 0-point ghost
rows, and `rankByTotals` ranked them. Ported just the round gate onto current `main`:
`ELIMINATION_ROUND_ORDER` / `isManagerActiveInRound` / `isManagerInRound` in `js/eligibility.js`
(canonical, unit-tested) mirrored into `server.js`, plus `roundParticipants` (bracket field via
`computePlayoffPairs`, so this can never disagree with the Playoff Bracket card).

Authority order is bracket field → `sd.eliminated`, and **every** unknown fails open. Note
`sd.eliminated[m]` is the round a manager went out _in_, so `'QF'` means they _played_ the QF —
active iff `elimIdx >= roundIdx`.

**Verified** (fabricated QF season: 12 managers, 8 the confirmed field, 4 knocked out in PP but
still holding PP rosters in `sd.rosters`), before/after on `/api/mlb/daily`:

|        | managers | player rows | active managers' today / round_total / rank |
| ------ | -------- | ----------- | ------------------------------------------- |
| before | 12       | 16          | 39.5/39.5/1 … 30.5/30.5/8                   |
| after  | 8        | 16          | **identical**                               |

The only diff is the four ghost rows disappearing. Fail-open confirmed three ways: pool-play date
→ 12; QF with `confirmed_seeding` deleted → 8 via `sd.eliminated`; QF with neither → 12.
343/343 tests (+10), lint + format clean.

### Gotcha worth remembering

Runtime stat keys in `daily_*.delta` are **lowercase** (`1b`, `r`, `rbi`, `ip`, `k`) — `SCORING`
is keyed uppercase (`'1B'`, `R`, …) and `calculateBattingScore` does the mapping. A fixture built
with the `SCORING` spelling scores a silent 0.
