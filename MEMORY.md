# WMMC — Decisions Log

## Index — every entry, newest first

Entries from **2026-07-29** onward live in this file. Older ones are in
[`MEMORY-ARCHIVE.md`](MEMORY-ARCHIVE.md) — same format, same rules, just not loaded by default.
Standing reference sections (Deployment workflow, Git identity, Mobile CSS patterns, Google
Sign-In) stay here regardless of age. **Search the archive before concluding something is new.**

| Date       | Entry                                                                                             | Where                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-19 | The 3rd-place game's two managers were told to submit a "Finals" roster                           | [MEMORY](#2026-08-19-the-3rd-place-games-two-managers-were-told-to-submit-a-finals-roster)                                        |
| 2026-08-19 | IL swaps now cover the Restricted List, and two IL statuses the gate had been missing             | [MEMORY](#2026-08-19-il-swaps-now-cover-the-restricted-list-and-two-il-statuses-the-gate-had-been-missing)                        |
| 2026-08-19 | Missing a roster deadline stopped being a dead end: late submissions, and begging the commish     | [MEMORY](#2026-08-19-missing-a-roster-deadline-stopped-being-a-dead-end-late-submissions-and-begging-the-commish)                 |
| 2026-08-18 | A swap on a round's last day stamped an add date in the NEXT period, and the roster leaked        | [MEMORY](#2026-08-18-a-swap-on-a-rounds-last-day-stamped-an-add-date-in-the-next-period-and-the-roster-leaked)                    |
| 2026-08-17 | `\b` treats `_` as a word character, so italicised manager names never got shortened              | [MEMORY](#2026-08-17-b-treats-_-as-a-word-character-so-italicised-manager-names-never-got-shortened)                              |
| 2026-08-17 | The semifinal was never an elimination round; the 3rd-place game lost its two rosters             | [MEMORY](#2026-08-17-the-semifinal-was-never-an-elimination-round-the-3rd-place-game-lost-its-two-rosters)                        |
| 2026-08-12 | Branch cleanup, and why `staging` stays                                                           | [MEMORY](#2026-08-12-branch-cleanup-and-why-staging-stays)                                                                        |
| 2026-08-11 | The scoreboard showed the bracket twice; the odds to advance moved onto the real one              | [MEMORY](#2026-08-11-the-scoreboard-showed-the-bracket-twice-the-odds-to-advance-moved-onto-the-real-one)                         |
| 2026-08-08 | Hot Takes read like a stat line: units, direction, and number density                             | [MEMORY](#2026-08-08-hot-takes-read-like-a-stat-line-units-direction-and-number-density)                                          |
| 2026-08-07 | Odds to advance in every round's final week, and the appearance-rate bug it exposed               | [MEMORY](#2026-08-07-odds-to-advance-in-every-rounds-final-week-and-the-appearance-rate-bug-it-exposed)                           |
| 2026-08-06 | Playoff daily Slack post: matchup deltas, Claude-written Hot Takes, short manager names           | [MEMORY](#2026-08-06-playoff-daily-slack-post-matchup-deltas-claude-written-hot-takes-short-manager-names)                        |
| 2026-08-06 | Deleting a dormant fallback is a risk decision, not a cleanup                                     | [MEMORY](#2026-08-06-deleting-a-dormant-fallback-is-a-risk-decision-not-a-cleanup)                                                |
| 2026-08-06 | Repo-wide PR/branch/dead-code audit, and why no endpoint was deleted                              | [MEMORY](#2026-08-06-repo-wide-prbranchdead-code-audit-and-why-no-endpoint-was-deleted)                                           |
| 2026-08-05 | Live tab boxscores scrolled inside their column while the page had empty gutters                  | [MEMORY](#2026-08-05-live-tab-boxscores-scrolled-inside-their-column-while-the-page-had-empty-gutters)                            |
| 2026-08-05 | The Hypothetical Zone, and two MLB sync bugs it uncovered                                         | [MEMORY](#the-hypothetical-zone-and-two-mlb-sync-bugs-it-uncovered-2026-08-05)                                                    |
| 2026-08-05 | The two queued "next tasks", and one of them was chasing the wrong thing                          | [MEMORY](#2026-08-05-the-two-queued-next-tasks-and-one-of-them-was-chasing-the-wrong-thing)                                       |
| 2026-08-05 | The slow scoreboard was `GET /api/seasons`, not the scoring pass                                  | [MEMORY](#2026-08-05-the-slow-scoreboard-was-get-apiseasons-not-the-scoring-pass)                                                 |
| 2026-08-05 | Redundancy audit: one real boot-time bug, one drift, and a scope correction                       | [MEMORY](#2026-08-05-redundancy-audit-one-real-boot-time-bug-one-drift-and-a-scope-correction)                                    |
| 2026-08-05 | Open-PR triage: #386 refreshed, #374 retired in favor of a focused round gate                     | [MEMORY](#2026-08-05-open-pr-triage-386-refreshed-374-retired-in-favor-of-a-focused-round-gate)                                   |
| 2026-08-03 | "End Quarterfinals" 409'd, didn't stick, and carried rosters into SF Week 1                       | [MEMORY](#end-quarterfinals-409d-didnt-stick-and-carried-rosters-into-sf-week-1-2026-08-03)                                       |
| 2026-08-03 | Round-end Slack post rebuilt: results, margin ordering, matchup-aware roasts, Friday reminder     | [MEMORY](#round-end-slack-post-rebuilt-results-margin-ordering-matchup-aware-roasts-friday-reminder-2026-08-03)                   |
| 2026-08-03 | Fallback roast bank: doubled, no-repeat within/across periods, article fix                        | [MEMORY](#fallback-roast-bank-doubled-no-repeat-withinacross-periods-article-fix-2026-08-03)                                      |
| 2026-08-03 | Roster-page elimination roasts: round-by-round sections, league ranks, and a negative-points bug  | [MEMORY](#roster-page-elimination-roasts-round-by-round-sections-league-ranks-and-a-negative-points-bug-2026-08-03)               |
| 2026-08-03 | Article bug had a SECOND class, and production has no ANTHROPIC*API_KEY *(finding 2 superseded)\_ | [MEMORY](#article-bug-had-a-second-class-and-production-has-no-anthropic_api_key-2026-08-03)                                      |
| 2026-08-03 | Roast repair buttons generalized to every round                                                   | [MEMORY](#roast-repair-buttons-generalized-to-every-round-2026-08-03)                                                             |
| 2026-08-03 | Day-by-day tally replaced with a per-round summary                                                | [MEMORY](#day-by-day-tally-replaced-with-a-per-round-summary-2026-08-03)                                                          |
| 2026-08-03 | Round summary became three tables; roasts are now server-authoritative on save                    | [MEMORY](#round-summary-became-three-tables-roasts-are-now-server-authoritative-on-save-2026-08-03)                               |
| 2026-08-03 | Round sections became three narrative lines over the tables                                       | [MEMORY](#round-sections-became-three-narrative-lines-over-the-tables-2026-08-03)                                                 |
| 2026-08-03 | The roast API call could 500 instead of falling back                                              | [MEMORY](#the-roast-api-call-could-500-instead-of-falling-back-2026-08-03)                                                        |
| 2026-07-31 | The duplicate 7am post was never in the code; it was a second webhook holder                      | [MEMORY](#2026-07-31-the-duplicate-7am-post-was-never-in-the-code-it-was-a-second-webhook-holder)                                 |
| 2026-07-30 | The drift audit's first alert was a false positive (effective-tomorrow adds)                      | [MEMORY](#2026-07-30-the-drift-audits-first-alert-was-a-false-positive-effective-tomorrow-adds)                                   |
| 2026-07-30 | The pool-play scoreboard shell came back, because the guard checked a proxy                       | [MEMORY](#2026-07-30-the-pool-play-scoreboard-shell-came-back-because-the-guard-checked-a-proxy)                                  |
| 2026-07-30 | Eliminated managers were still being tagged on Live box scores                                    | [MEMORY](#2026-07-30-eliminated-managers-were-still-being-tagged-on-live-box-scores)                                              |
| 2026-07-29 | A mid-week swap erased the outgoing player from My Roster's week                                  | [MEMORY](#a-mid-week-swap-erased-the-outgoing-player-from-my-rosters-week-2026-07-29)                                             |
| 2026-07-29 | Eliminated managers' stale playoff rosters blocked the swap pool                                  | [MEMORY](#eliminated-managers-stale-playoff-rosters-blocked-the-swap-pool-2026-07-29)                                             |
| 2026-07-29 | `backfillRosterDatesFromSwaps` was clobbering effective-tomorrow drop dates                       | [MEMORY](#2026-07-29-backfillrosterdatesfromswaps-was-clobbering-effective-tomorrow-drop-dates)                                   |
| 2026-07-29 | Live tab: "live day" replaces the hard midnight cutoff                                            | [MEMORY](#2026-07-29-live-tab-live-day-replaces-the-hard-midnight-cutoff)                                                         |
| 2026-07-29 | Live board dropped a swapped-out player's points on his final rostered day                        | [MEMORY](#2026-07-29-live-board-dropped-a-swapped-out-players-points-on-his-final-rostered-day)                                   |
| 2026-07-29 | Live tab: cache the MLB fetch layer, never the roster layer                                       | [MEMORY](#2026-07-29-live-tab-cache-the-mlb-fetch-layer-never-the-roster-layer)                                                   |
| 2026-07-29 | Duplicate 7am Slack post showing "Current Period: Season"                                         | [MEMORY](#duplicate-7am-slack-post-showing-current-period-season-2026-07-29)                                                      |
| 2026-07-29 | Season-opening welcome post + confirming the round cadence                                        | [MEMORY](#season-opening-welcome-post-confirming-the-round-cadence-2026-07-29)                                                    |
| 2026-07-29 | A mid-week trade erased the outgoing manager's drop-day points                                    | [MEMORY](#2026-07-29-a-mid-week-trade-erased-the-outgoing-managers-drop-day-points)                                               |
| 2026-07-29 | A wrong certified total sat in Slack for three hours with nothing watching                        | [MEMORY](#2026-07-29-a-wrong-certified-total-sat-in-slack-for-three-hours-with-nothing-watching)                                  |
| 2026-07-28 | Managers can edit/cancel their OWN swap until it takes effect                                     | [archive](MEMORY-ARCHIVE.md#managers-can-editcancel-their-own-swap-until-it-takes-effect-2026-07-28)                              |
| 2026-07-28 | A scheduled swap must not apply early in the roster VIEWS                                         | [archive](MEMORY-ARCHIVE.md#a-scheduled-swap-must-not-apply-early-in-the-roster-views-2026-07-28)                                 |
| 2026-07-28 | My Roster scoring blocks redesigned as a Pool Play → playoffs flow                                | [archive](MEMORY-ARCHIVE.md#2026-07-28-my-roster-scoring-blocks-redesigned-as-a-pool-play-playoffs-flow)                          |
| 2026-07-25 | Today is always a valid swap effective date — game start time, not the calendar                   | [archive](MEMORY-ARCHIVE.md#today-is-always-a-valid-swap-effective-date-game-start-time-not-the-calendar-2026-07-25)              |
| 2026-07-22 | No login-screen flash on reload for logged-in users                                               | [archive](MEMORY-ARCHIVE.md#2026-07-22-no-login-screen-flash-on-reload-for-logged-in-users)                                       |
| 2026-07-22 | Pool cleanup Scan→Apply infinite loop: retired phantoms re-reported forever                       | [archive](MEMORY-ARCHIVE.md#2026-07-22-pool-cleanup-scanapply-infinite-loop-retired-phantoms-re-reported-forever)                 |
| 2026-07-21 | Scheduled swaps (manager, future-only) + commissioner date editing                                | [archive](MEMORY-ARCHIVE.md#scheduled-swaps-manager-future-only-commissioner-date-editing-2026-07-21)                             |
| 2026-07-21 | IL check "unverified" root cause: sd.mlb_ids coverage, not the MLB API                            | [archive](MEMORY-ARCHIVE.md#2026-07-21-il-check-unverified-root-cause-sdmlb_ids-coverage-not-the-mlb-api)                         |
| 2026-07-21 | Commissioner To-Do card (PR #365)                                                                 | [archive](MEMORY-ARCHIVE.md#2026-07-21-commissioner-to-do-card-pr-365)                                                            |
| 2026-07-20 | Swap automation: auto-apply on submit + playoff limits + MLB IL verification                      | [archive](MEMORY-ARCHIVE.md#swap-automation-auto-apply-on-submit-playoff-limits-mlb-il-verification-2026-07-20)                   |
| 2026-07-20 | Live tab playoff bracket view + bracket mobile readability                                        | [archive](MEMORY-ARCHIVE.md#live-tab-playoff-bracket-view-bracket-mobile-readability-2026-07-20)                                  |
| 2026-07-20 | Banner stuck on PP2 W5 after break: calendar week now wins both ways (PR #356)                    | [archive](MEMORY-ARCHIVE.md#2026-07-20-banner-stuck-on-pp2-w5-after-break-calendar-week-now-wins-both-ways-pr-356)                |
| 2026-07-17 | All-Star break banner + bracket-first scoreboard (PR #353)                                        | [archive](MEMORY-ARCHIVE.md#2026-07-17-all-star-break-banner-bracket-first-scoreboard-pr-353)                                     |
| 2026-07-17 | Break-time submission warning + explicit scoreboard expand (PR after #353)                        | [archive](MEMORY-ARCHIVE.md#2026-07-17-break-time-submission-warning-explicit-scoreboard-expand-pr-after-353)                     |
| 2026-07-15 | Daily Slack post: playoff cadence + bracket matchups                                              | [archive](MEMORY-ARCHIVE.md#daily-slack-post-playoff-cadence-bracket-matchups-2026-07-15)                                         |
| 2026-07-12 | Mobile scoreboard: Total column restored next to Playoff %                                        | [archive](MEMORY-ARCHIVE.md#2026-07-12-mobile-scoreboard-total-column-restored-next-to-playoff)                                   |
| 2026-07-12 | Mobile scoreboard polish: aligned score column + odds-table headers                               | [archive](MEMORY-ARCHIVE.md#2026-07-12-mobile-scoreboard-polish-aligned-score-column-odds-table-headers)                          |
| 2026-07-10 | Swap-chain grouping applied to every roster listing                                               | [archive](MEMORY-ARCHIVE.md#2026-07-10-swap-chain-grouping-applied-to-every-roster-listing)                                       |
| 2026-07-06 | Playoff odds: Monte-Carlo prediction section, PP2 Weeks 4–5                                       | [archive](MEMORY-ARCHIVE.md#playoff-odds-monte-carlo-prediction-section-pp2-weeks-45-2026-07-06)                                  |
| 2026-07-06 | Timezone display: server stamps are zone-less UTC; render browser-local with zone abbrev          | [archive](MEMORY-ARCHIVE.md#timezone-display-server-stamps-are-zone-less-utc-render-browser-local-with-zone-abbrev-2026-07-06)    |
| 2026-07-05 | Swap approve/undo skipped the date-window recompute — phantom +57 + guard-block loop              | [archive](MEMORY-ARCHIVE.md#swap-approveundo-skipped-the-date-window-recompute-phantom-57-guard-block-loop-2026-07-05)            |
| 2026-07-05 | Swap Log filters: chips → dropdowns + mobile layout fix                                           | [archive](MEMORY-ARCHIVE.md#swap-log-filters-chips-dropdowns-mobile-layout-fix-2026-07-05)                                        |
| 2026-07-03 | Mobile full-tab redesign                                                                          | [MEMORY](#mobile-full-tab-redesign-established-2026-07-03-pr-335)                                                                 |
| 2026-07-02 | Season Stats tab: accolades + merged Trends                                                       | [archive](MEMORY-ARCHIVE.md#season-stats-tab-accolades-merged-trends-2026-07-02)                                                  |
| 2026-06-19 | Scoreboard PP1/PP2 manager-click panels bled into each other                                      | [archive](MEMORY-ARCHIVE.md#scoreboard-pp1pp2-manager-click-panels-bled-into-each-other-2026-06-19)                               |
| 2026-06-10 | Player-name identity: duplicate-name pool keys + roster-fix purge guard                           | [archive](MEMORY-ARCHIVE.md#player-name-identity-duplicate-name-pool-keys-roster-fix-purge-guard-2026-06-10)                      |
| 2026-06-10 | Daily rows off the seasons payload — on-demand fetch + server-authoritative                       | [archive](MEMORY-ARCHIVE.md#daily-rows-off-the-seasons-payload-on-demand-fetch-server-authoritative-2026-06-10)                   |
| 2026-06-10 | GET /api/seasons slimmed + score_snapshots made server-authoritative                              | [archive](MEMORY-ARCHIVE.md#get-apiseasons-slimmed-score_snapshots-made-server-authoritative-2026-06-10)                          |
| 2026-06-10 | Scoreboard differed per device / fresh browser empty — localStorage quota, not HTTP cache         | [archive](MEMORY-ARCHIVE.md#scoreboard-differed-per-device-fresh-browser-empty-localstorage-quota-not-http-cache-2026-06-10)      |
| 2026-06-08 | Per-round Manager Submission Status (collapsible, auto-open current period)                       | [archive](MEMORY-ARCHIVE.md#per-round-manager-submission-status-collapsible-auto-open-current-period-2026-06-08)                  |
| 2026-06-08 | reconcile-boundary-rosters endpoint — prune array-only orphans from a backed roster               | [archive](MEMORY-ARCHIVE.md#reconcile-boundary-rosters-endpoint-prune-array-only-orphans-from-a-backed-roster-2026-06-08)         |
| 2026-06-08 | Approval conflict check + roster write read/wrote the array, not authoritative sources            | [archive](MEMORY-ARCHIVE.md#approval-conflict-check-roster-write-readwrote-the-array-not-authoritative-sources-2026-06-08)        |
| 2026-06-08 | "Your view is out of date" 409 on submission approval → submission approved but roster lost       | [archive](MEMORY-ARCHIVE.md#your-view-is-out-of-date-409-on-submission-approval-submission-approved-but-roster-lost-2026-06-08)   |
| 2026-06-08 | Submission-approval duplicate check wasn't period-scoped → false "already on another roster"      | [archive](MEMORY-ARCHIVE.md#submission-approval-duplicate-check-wasnt-period-scoped-false-already-on-another-roster-2026-06-08)   |
| 2026-06-08 | Carry-forward repair leaked across period boundaries → orphan PP2 Week-1 rosters                  | [archive](MEMORY-ARCHIVE.md#carry-forward-repair-leaked-across-period-boundaries-orphan-pp2-week-1-rosters-2026-06-08)            |
| 2026-06-08 | PP2 submission window closed ~a day early — midnight fallback in getPeriodFirstGame               | [archive](MEMORY-ARCHIVE.md#pp2-submission-window-closed-a-day-early-midnight-fallback-in-getperiodfirstgame-2026-06-08)          |
| 2026-06-08 | `sd.rosters` wiped by a stale full-season save → Best/Worst Slack section vanished, scores froze  | [archive](MEMORY-ARCHIVE.md#sdrosters-wiped-by-a-stale-full-season-save-bestworst-slack-section-vanished-scores-froze-2026-06-08) |
| 2026-06-07 | Scoreboard manager-detail: group players by period + heal arrays so breakdowns reconcile          | [archive](MEMORY-ARCHIVE.md#scoreboard-manager-detail-group-players-by-period-heal-arrays-so-breakdowns-reconcile-2026-06-07)     |
| 2026-06-07 | Ghost player caused recurring 4am score-guard block — Joey Auclair / Iván Herrera                 | [archive](MEMORY-ARCHIVE.md#ghost-player-caused-recurring-4am-score-guard-block-joey-auclair-ivn-herrera-2026-06-07)              |
| 2026-06-07 | Roster-date display hardening + duplicate repair-swap dedup                                       | [archive](MEMORY-ARCHIVE.md#roster-date-display-hardening-duplicate-repair-swap-dedup-2026-06-07)                                 |
| 2026-06-06 | Approving a not-yet-started period's submission was purged by carry-forward repair                | [archive](MEMORY-ARCHIVE.md#approving-a-not-yet-started-periods-submission-was-purged-by-carry-forward-repair-2026-06-06)         |
| 2026-06-06 | Atomic roster-submission endpoints — stop lost/clobbered submissions                              | [archive](MEMORY-ARCHIVE.md#atomic-roster-submission-endpoints-stop-lostclobbered-submissions-2026-06-06)                         |
| 2026-06-06 | PP1 submission window gating + delete capability                                                  | [archive](MEMORY-ARCHIVE.md#pp1-submission-window-gating-delete-capability-2026-06-06)                                            |
| 2026-06-06 | Phase 3 — retire the hardcoded band-aids                                                          | [archive](MEMORY-ARCHIVE.md#phase-3-retire-the-hardcoded-band-aids-2026-06-06)                                                    |
| 2026-06-06 | Scoring eligibility fixes — cross-manager leak + carry-forward                                    | [archive](MEMORY-ARCHIVE.md#scoring-eligibility-fixes-cross-manager-leak-carry-forward-2026-06-06)                                |
| 2026-06-06 | Score-swing guard + daily snapshot trail                                                          | [archive](MEMORY-ARCHIVE.md#score-swing-guard-daily-snapshot-trail-2026-06-06)                                                    |
| 2026-06-05 | Weekly Team Scoring rework                                                                        | [archive](MEMORY-ARCHIVE.md#weekly-team-scoring-rework-2026-06-05)                                                                |
| 2026-06-04 | Google Sign-In                                                                                    | [MEMORY](#google-sign-in-added-2026-06-04)                                                                                        |
| 2026-06-04 | Deployment workflow                                                                               | [MEMORY](#deployment-workflow-established-2026-06-04-updated-2026-06-05)                                                          |
| 2026-06-04 | Git identity — run at session start                                                               | [MEMORY](#git-identity-run-at-session-start-established-2026-06-04)                                                               |
| 2026-06-04 | Mobile CSS patterns                                                                               | [MEMORY](#mobile-css-patterns-established-2026-06-04)                                                                             |

## 2026-08-19 — The 3rd-place game's two managers were told to submit a "Finals" roster

**The situation.** Every submission surface calls the last period "Finals" — the card's badge,
its "Submit your roster for Finals" line, the yellow warning banner, the late-deadline banner,
every confirm dialog. But that period is TWO games over the same two weeks: the Championship
between the semifinal winners and the 3rd-place game between the losers (see the 2026-08-17
entry — the semifinal eliminates nobody). So half the managers submitting were being told to
file a roster for a game they had already lost their way out of.

**The fix is a label, derived rather than assumed.** `finalsGameFor` / `finalsGameLabel`
(js/eligibility.js, unit-tested) take the round's field — the finalists (SF winners) and all four
semifinalists — and name the game the manager is actually in: **Finals**, **3rd Place Game**, or,
when the semifinals aren't finalized yet, **Finals / 3rd Place**. That last case is the one worth
being deliberate about: with no field known, naming one game would tell a semifinalist he is in
the Championship. Both games, or nothing.

**Which surface gets which name.** app.js's `submissionPeriodLabel` names a period for ONE
manager (card, warning banner, late banner, every confirm/alert that already had a manager in
hand); `periodLabelForAll` names it for surfaces that span managers (the commissioner's approval
queue heading, the submission status table's section), where it really is both games. In between,
per-row: the approval queue tags each pending manager with his game, because in that period which
of the two he submitted for is the thing being approved.

**The bug found next door.** The commissioner's submission status table listed the Finals section
from `getFinalsParticipants` — the two finalists. But all four semifinalists submit a Finals-period
roster, so the table hid half the rosters he has to chase and approve, and its counts said "of 2"
when they were of 4. It now lists `getSFParticipants` with each row labelled by game. Same root
cause as the 2026-08-17 entry: "Finals period" and "the Finals" are not the same set.

**Verified in the running app** (scratch season sitting in Finals Week 1, QF+SF finalized):
Sullivan/Gillespie (the SF losers) see `3RD PLACE GAME — Player Submission` and a banner reading
"Your 3rd Place Game lineup is not submitted"; Kortan/McCallum see Finals. With the deadline moved
into the past, late mode reads "You missed the 3rd Place Game roster deadline". The commissioner's
queue reads "Pending Finals / 3rd Place Approvals" with per-manager game tags, and the status table
shows all four semifinalists — 2 pending, 2 not submitted, of 4.

## 2026-08-19 — IL swaps now cover the Restricted List, and two IL statuses the gate had been missing

**The ask.** Ketel Marte was on the Restricted List, not the IL, and the league wanted RL to count
for an IL swap. The first question was purely factual: what does the MLB Stats API actually return
for that status?

**Nobody could answer it from memory, and the wrong guess was waiting.** `RM` looks like the
Restricted List and is not — it is **"Reassigned to Minors", 300 players league-wide** against the
RL's 28. Adding `RM` to the code set would have opened IL swaps to every minor-league reassignment
in baseball. The real code is **`RST`**. This is the whole argument for
`scripts/mlb-roster-status.js`: it hits `/api/v1/people/:id?hydrate=rosterEntries` and, with
`--sweep`, enumerates every status code across all 30 full rosters with the gate's verdict for
each. Re-run it rather than reasoning about codes. (The full observed table lives in the script's
header.)

**The sweep found two pre-existing gaps, which is the part nobody asked for.** `ILF`
("Injured - Full Season", **240 players** — the second-largest injured population in the league)
was clearing the gate _only_ through the `/injured/i` description fallback; its code was never in
`MLB_IL_STATUS_CODES`. That regex was load-bearing without anyone knowing. And `RA`
("Rehab Assignment") was rejected outright, though a rehabbing player has not been activated and is
still on the IL. Both are now named in the set, renamed `IL_SWAP_ELIGIBLE_STATUS_CODES` since it
no longer means only "injured". The regex stays as a catch-all for codes MLB adds later, but
nothing depends on it now.

**The menu was relabelled, not renamed.** Managers see "IL/RST Swap"; the stored value is still
`'IL Swap'`. That distinction is the load-bearing one: the string is written on every swap record
in `db.json` back to the first season, and both `checkSwapLimit` and the server's gate compare
against it. `swapReasonLabel` (`js/swaps.js`, client-only, deliberately not mirrored in
`server.js`) maps stored value → display text at the six render sites, and passes through anything
it has no label for. No data migration, no historical record reinterpreted.

**Verified in the browser, not only in tests.** The bridge — `app.js` calling the bare global
`swapReasonLabel`, populated by `js/index.js` — is the kind of thing unit tests cannot catch. Drove
the running app with Playwright to My Roster → Swaps: the option renders `value="IL Swap"` with
visible text `IL/RST Swap`, no page errors.

**Still open, deliberately.** The Slack swap notification prints the stored `'IL Swap'` rather than
the label. Left alone: its `Reason:` line already appends `(MLB status: Restricted List)` from
`il_status`, so the post is self-explanatory, and the server has no business owning display labels.

## 2026-08-19 — Missing a roster deadline stopped being a dead end: late submissions, and begging the commish

**The situation.** Finals Week 1 opened Aug 17. By Aug 19 one manager (Thally) still had no
Finals roster, and the app had nothing to offer him: past a period's lock the submission card
rendered the single line "Submission window has closed." and no form. The only route back in was
the commissioner editing data by hand.

**The rule we chose.** A missed deadline moves the roster's START DATE; it does not remove the
roster. Submit before the day's first pitch and it takes effect today; submit after it and it
takes effect tomorrow. Never earlier than the period starts, never past its end. That is the
whole design: a late manager still plays, but he can never read a finished box score and then buy
into it.

**Why it needed almost no new scoring code.** The effective date IS the players' `add_date`. Once
approval stamps that instead of the period's Week 1 start, `managerWeekSubtotal`,
`managerRowScoreForWeek` and `rebuildRosterArraysFromDates` clip the window with machinery that
has existed since the invariant was written. Verified against the real engine on a scratch season:
three identical Aaron Judge days (Aug 17/18/19, 14 pts each) scored **42** with `add_date`
Aug 17, **14** with Aug 19, and **0** with Aug 20. One field, three answers, no special case.

**The server owns the date, and that is not incidental.** Two inputs decide it — has today's slate
started (MLB Stats API) and what day is it (a clock) — and a manager controls neither on the
server. The date is the scoring invariant's own unit, so letting a client propose it is letting a
manager pick his own start day after seeing the results. `resolveSubmissionWindow` answers both
questions; `GET /api/seasons/:year/submission-window/:period` exposes it for rendering and
`POST /submissions` stamps it. app.js keeps `getPeriodDeadline` for instant rendering, but late
mode reads `SUBMISSION_WINDOWS` — the server's answer — so a wrong local clock or a missing
`period_deadlines` entry can never move a start date.

**"Beg Commish for Forgiveness".** The second button files the roster as a plea:
`forgiveness_status: 'pending'`, no effective date, a Slack ping with the manager's case.
`POST .../forgiveness` is commissioner-only and is the ONLY path that can start a roster earlier
than the automatic rule — the date comes out of a picker bounded to the period, and the server
re-validates it. Denying does not discard the roster: it drops to the automatic date, so a manager
who asked and was refused is exactly where he'd have been had he just hit Submit.

**Two guards worth keeping.** (1) Approving a late submission with no effective date is blocked
client-side — without it, the old code path falls back to the period's Week 1 start, which is a
free back-date handed out by a misclick. (2) Late mode only renders while the period is still
RUNNING (or a late record already exists). Without that, every manager without a PP1 submission
on file would carry a permanent "you missed Pool Play 1" form on their roster page for the rest of
the season.

**What the banner does now.** The submission-warning banner used to go silent once a deadline
passed — quiet on exactly the manager who most needed it. It now says "You missed the Finals
roster deadline. You can still submit — it would count from Wednesday, Aug 19." Every day he
ignores it, that date gets worse, which is the correct incentive.

**Fallbacks.** An unreachable MLB schedule degrades to an 11:00 AM ET cutoff (early enough to
cover a holiday 11:10 first pitch, and erring toward pushing to tomorrow — the safe direction). An
EMPTY slate counts as "not started": there is no box score to have read, so today stays viable.
The lock time itself prefers `sd.period_deadlines[period]` and otherwise fetches the period
opening day's real first pitch rather than adding a fourth copy of a season-specific time table.

**Files.** `js/lateSubmission.js` (new, canonical, 44 unit tests) mirrored into `server.js` and
guarded by `tests/serverMirrors.test.js`; endpoints and stamping in `server.js`; late-mode card,
plea box, commissioner picker and the approval date in `app.js`.

## 2026-08-18 — A swap on a round's last day stamped an add date in the NEXT period, and the roster leaked

**The report.** Jamie Rogers' Finals roster showed four pitchers on a three-pitcher staff: Sale,
Luzardo and Crochet tagged `Added Aug 17`, plus Nick Lodolo tagged with a bare week range. The
swap that brought Lodolo in was `SF · Week 2`, approved, dates correct on its face.

**Two facts unlock it.** First, the screen was **Finals Week 1**, not SF Week 2 — SF Week 2 is
Aug 10–16 and Aug 17–23 is the Finals. Second, the three "Added Aug 17" pitchers are exactly what
an approved period submission stamps (`add_date = the period's Week 1 start`), and Lodolo had **no**
`roster_dates` entry under `Finals|Week 1` at all — which is why his tag fell through to the plain
week range while the others read `Added`. That difference is the tell, and it is worth remembering
as a diagnostic: on a period's first week, `Added <period start>` means submitted, a bare week
range means arrived some other way.

**The mechanism.** The swap was submitted Sun Aug 16, the last day of SF Week 2, with CIN already
playing. The game-started rule gives `drop_date = today, add_date = tomorrow` — and tomorrow was
Aug 17, the first day of a new submission period. The entry was written into the `SF|Week 2`
bucket, correctly, but **the eligibility scan selects by DATE, not by which bucket the entry sits
in**: `add_date >= periodStart && add_date <= weekEnd`. For `Finals|Week 1`, `periodStart` is
Aug 17, so an SF-bucket entry cleared a Finals filter. `getWeekRoster`, `rebuildRosterArraysFromDates`
and `managerWeekSubtotal` all share that shape, so it was a scoring bug, not a display bug.

The control case was sitting in the same data: **Hayden Wesneski**, added Aug 15, never dropped,
same `SF|Week 2` bucket — and he did NOT carry over. Only the add date exactly equal to the period
start leaked. The period guard works; the date was wrong.

**It also did nothing for the semifinal.** `drop_date` is inclusive, so Cantillo scored all of
SF Week 2 anyway and Lodolo's window never opened in it. A Drop Swap was consumed for zero effect.
Both harms come from the same date, which is why the fix is a refusal rather than a repair:
`checkSwapEffectiveWindow` (`js/swaps.js` ↔ `server.js`, mirror-tested) rejects the submission
before `sd.swaps.push`, so no allotment is spent. Auto path only — a scheduled date was already
bounded on both `POST /swaps` and `PUT /swaps/:id`. PR #442.

**Undo was not enough, and that is the lesson worth keeping.** Undoing the swap cleaned
`roster_dates` — the source of truth — but Lodolo stayed on the Finals roster and would have kept
scoring, because `rebuildRosterArraysFromDates` had already pushed him into
`sd.rosters[mgr]['Finals|Week 1'].pitchers` and **that heal is purely additive by design**: it
cannot remove anything, and the undo only cleans the swap's own `week_key`. `managerWeekSubtotal`
seeds eligibility with `...weekRoster[listKey]`, so a stale array entry scores even with no date
window behind it. `POST /roster-remove` was what actually cleared it.

So: a derived cache that only ever grows is not self-healing, and "the source of truth is correct
now" does not mean the scoreboard is. Teaching the heal to PRUNE players no longer active by dates
is the open follow-up — deliberately not folded into #442, because it moves every manager's
arrays and needs its own before/after totals vet.

## 2026-08-17 — `\b` treats `_` as a word character, so italicised manager names never got shortened

Found while building the round-end preview (entry below), fixed here on its own once the
commissioner asked for it.

`shortenManagerNamesInSlack` rewrote full names to short ones with `\bFull Name\b`. `\b` is
defined against `\w`, and **`\w` includes underscore** — which is Slack's italic marker. So
`_Ryan Sullivan_` failed the boundary test at BOTH ends and came out long, while `*Ryan Sullivan*`
and `Ryan Sullivan.` in the same post came out short. One post, one manager, two different names.
`*` and `~` were always fine; only `_` was ever affected, which is why this survived so long.

The fix is one constant: `NAME_EDGE = '[A-Za-z0-9]'`, used as `(?<!…)name(?!…)` instead of `\b`.
That is _exactly_ the `\b` semantics minus underscore — verified by diffing old against new over
markup, punctuation and glued-letter cases: only the underscore cases move, everything else is
byte-identical. Letters and digits delimit a name; markup and punctuation do not.

**The function moved to `js/utils.js` to get it under test.** It was server-only, and the project
rule is that tests cover pure `js/` modules — so a boundary regex that every Slack post in the
league depends on had no test at all, which is the actual reason the bug lasted. It is now the
canonical copy (mirrored back into `server.js`, guarded by `tests/serverMirrors.test.js`) with
twelve cases, including the italic regression and the "still refuses to match a name glued to
letters or digits" case that keeps the fix from being over-broad. No frontend caller, same as
`js/playoffCommentary.js`.

Verified live as well as in unit tests: with two fixture managers renamed to share a first name,
a real SF round-end post through a local webhook sink rendered `_History:_ Ryan D. …` and
`*Ryan D.* vs *Ryan C.*` — one name for the same manager everywhere in the post.

## 2026-08-17 — The semifinal was never an elimination round; the 3rd-place game lost its two rosters

**The bug.** "End Semifinals → Advance Finals Teams & Dump SF Loser Rosters" treated the semifinal
like the quarterfinal: it deleted the two losers' Finals submissions and stamped
`sd.eliminated[loser] = 'SF'`. But the semifinal eliminates nobody. Its losers play the **3rd-place
game, and the 3rd-place game is contested over the same two Finals weeks** as the Championship —
`SEASON_SCHEDULE` has literally said `Finals / 3rd Place - Week 1` all along. So the dump deleted a
roster a manager had already submitted for a game he was still playing, and then locked both of
them out of resubmitting: `isManagerActiveInRound('Finals', 'SF')` was `false`, and the submission
card rendered "Season ended in Semifinals."

`js/playoffStatus.js` had the ladder right the whole time (SF ends → the two losers flip to a
**live** Consolation). `js/eligibility.js` and the dump action did not. Two models of the same
bracket, and the wrong one owned the submission form.

**The fix is one function, applied on read.** `lastRoundPlayed(eliminatedRound)` maps `'SF'` →
`'Finals'`, and `isManagerActiveInRound` runs its index lookup through it. Deliberately a read-time
normalization and not a data migration: it repairs every season already stamped the old way,
including this one, the moment it deploys — no db.json surgery, nothing to get wrong at 4am. The
pair is mirrored into `server.js` and is now guarded by `tests/serverMirrors.test.js`.

Downstream of that, app.js grew ONE `isManagerEliminatedForPeriod` helper (period → round, then ask
the shared rule) replacing the two hardcoded `['PP','QF','SF']` lists that had been kept in step by
hand — the submission card and the submission-warning banner.

**The SF transition is now its own action.** `dumpPlayoffLosers` is quarterfinals-only and says so
if called otherwise. `advanceToFinalsAndThirdPlace` deletes no submission, writes no elimination,
and is idempotent so it doubles as the repair: re-running it clears stale `'SF'` elimination marks
and withdraws the "your season is over" roasts wrongly stored against the SF round. Those roasts
needed a new endpoint — `DELETE /api/seasons/:year/roasts/:round` — because `sd.roasts` is
server-authoritative and a full-season save can only ever ADD to it. **The local mirror in
`clearRoastsForRound` is load-bearing for the same reason**: the server merges an incoming save's
roasts UNDER its own, so a following save still carrying the deleted text would put all of it back.
The server independently clears its roast set for `round === 'SF'` rather than trusting the caller.

**The SF post had nothing left to say, so it got a preview.** New pure module `js/roundPreview.js`
(mirrored, unit-tested): each Finals-week game with both managers' bracket form, the per-round
split behind it, who carried them there, one career fact apiece from `managerPlayoffHistory`, and an
"early edge". The edge line is labelled **form, not a forecast**, on purpose — every playoff round
opens a fresh submission period, so semifinal points are evidence about the manager and not about a
roster that does not exist yet. Pairings come from `computePlayoffPairs`, the same function the
results block above it uses, so the preview can never name a matchup the post contradicts; top
performers come through `managerWeekSubtotal`, not the `sd.rosters` cache, so a mid-round swap is
credited for exactly its own days. The SF results footer now names the 3rd-place pair too.

**A live gotcha found by actually posting it.** The history line originally rendered as
`_Alice Adams has never…_`. Slack's italic marker is `_`, `_` is a word character, and
`shortenManagerNamesInSlack` matches on `\b` — so a full name at the HEAD of an italic run is the
one mention in a post that never gets shortened, while every other mention of the same manager
does. Fixed here by labelling the line (`_History:_ …`) so a non-name word comes first. **The
shortener itself is still wrong for this case and is untouched** — changing name-boundary semantics
for every post in the league, mid-playoffs, to fix a cosmetic issue is not a trade worth making
unasked.

Verified against a synthetic 2026 season on a scratch `DB_PATH` with the webhook pointed at a local
sink: the SF post carries no Hall of Shame even with stale `'SF'` marks still in the data, the QF
post is unchanged, and in the real browser the SF loser gets a live Finals submission form while the
QF loser still reads "Season ended in Quarterfinals."

## 2026-08-12 — Branch cleanup, and why `staging` stays

Routine sweep: **zero open PRs** (the newest is #436, merged 2026-08-11) and only four remote
branches. `claude/scoreboard-playoff-matchups-hx55p8` (#436) and `claude/slack-post-messaging-fgzz42`
(#435) were both merged and their tips were ancestors of `main`, so they carried nothing; the
commissioner deleted them. **Agent sessions still get HTTP 403 on ref deletion** — pushes work,
deletes do not, exactly as the 2026-08-06 audit found. Hand the commands over; don't report the
deletion as done.

**`staging`'s "838 commits ahead" is a lie told by commit counts.** `git rev-list --left-right`
reads 28/838 against `main`, which looks like a branch full of unique work. It has none. Those 838
are history noise: the same changes reached `main` under different SHAs via PR merge commits, so
they share no identity with staging's copies. The check that settles it is the tree, not the log —
`git diff $(git merge-base main staging) staging` came back **empty**, meaning staging's tree was
byte-identical to `main` at `5072849` (2026-08-06). It was simply 28 commits stale. Do that diff
first next time; the ahead/behind numbers on this branch will never be informative.

The refresh (`git merge origin/main` into `staging`) was conflict-free for the same reason — one
side had no changes to conflict with — and `git diff origin/main HEAD` was empty before pushing.
481 tests, lint and Prettier all clean.

**Decision: keep `staging`.** The 2026-08-06 audit floated retiring the branch and its `render.yaml`
block together, since it has now drifted 240 → 820 → 28 commits behind across three cleanups. The
commissioner's call is that it earns its keep for QA'ing bigger changes before they hit production,
so the branch and the `wmmc-staging` service both stay. Treat the drift as a chore to repeat, not a
smell to fix — and note staging reseeds from `managers_seed.json` on every deploy (no disk, no
`DB_PATH`), so a QA pass wanting realistic rosters needs `tests/fixtures/staging-seed.json`, which
the service's Start Command copies to `db.json` on boot.

**The pre-push hook needs two pushes, and this is not obvious.** `.githooks/pre-push` stamps
`version.json` and commits — but git computes the refs to push _before_ running the hook, so that
commit is created after the push list is frozen and stays local. The first push reported
`5f5044b..57eb994` and left `17179ff` behind; a second push sent it. Verify with
`git ls-remote origin refs/heads/<branch>` rather than trusting the push output, because the second
push prints a confusing "Everything up-to-date" while still moving the ref. This is why `main`'s
history shows "chore: stamp version" commits landing alongside the work rather than after it. It
also leaves `staging` differing from `main` by exactly one line — `version.json`'s date stamp — which
is expected, since the hook maintains that cache-buster per branch.

One local-only trap: `npm run lint` failed with `Cannot find module '@eslint/js'` on a fresh
container whose `node_modules` predated the merge. Environment, not code — `npm install` fixed it.

## 2026-08-11 — The scoreboard showed the bracket twice; the odds to advance moved onto the real one

Commissioner sent a screenshot of the Scoreboard tab mid-Semifinals: collapsible `Quarterfinals` /
`Semifinals` sections, each holding the round's matchup cards. His read was that it is an "extra"
view, because the Playoffs section above it already shows all of them — and that the one thing he
actually wanted there was the % likelihood to advance that the Slack post has been carrying since
2026-08-07.

He was right about the duplication, and it was worse than "two views of the same thing". Once pool
play is finalized, `orderScoreboardBracket` moves `#scoreboard-bracket` ABOVE `#scoreboard-content`,
so the page led with the Playoff Bracket card and then repeated the same eight matchups a screen
later — same pairings, same totals, same B/P split, from two different code paths
(`buildActivePlayoffBracket` vs `renderPlayoffMatchupCards`). The bracket card is strictly the
richer of the two: its rows expand into that round's per-player breakdown, the cards never did.
So `renderPlayoffMatchupCards` and the QF/SF/Finals section block are gone, along with
`renderPlayoffTable` (its only other caller) and the two CSS rules that existed solely for those
cards (`.matchup-team-sub`, `.matchup-team.matchup-leader`). The HISTORICAL-season scoreboard's own
QF/SF/Finals sections (`renderScoreboardSections`, a different function) were left alone — a
finished season has no bracket card sitting above them.

**The odds now render on the bracket card**, one pill per row between the name and the score, in
the same `.odds-pill` colour family the pool-play odds already use. `sd.bracket_odds` was already
being shipped to clients and already preserved across a full-season save; nothing on the server
changed. The only plumbing needed was bridging `bracketOddsWindowForDate` onto `window` in
`js/index.js` (and into `eslint.config.js`'s globals).

**The gate is the interesting part.** `advanceOddsHtml` mirrors the server's `bracketOddsForPost`
exactly — wrong date, wrong round, round since finalized, or outside the final-week window all mean
render nothing — and then adds one check the server does not need: the payload's `opponent` must
equal the name across the bracket row. The reason is that these two things derive their pairings
differently. The server builds them with `computePlayoffPairs`; the bracket card builds its own
from the seeding plus the prior round's winners. They agree today, but a % is a claim about one
specific matchup, so if they ever stop agreeing the correct output is no pill rather than a number
attached to the wrong opponent. Same principle that made `bracketOddsForPost` drop stale payloads:
a wrong % beside a live score is worse than no %.

**Verified in the running app** (per the `verify` skill) against a fabricated `db.json` — pool play
and QF finalized, SF live in its final week, a stored SF `bracket_odds` payload. Confirmed at 1280px
and at 390×844: four pills in the SF column and none in the QF column (the round check working),
`78%` / `22%` / `🔒 100%` / `0%` covering the high/low/clinched branches, the legend line rendering
once for the card, and zero `.matchup-results-grid` left anywhere in `#scoreboard-content`. On the
phone the pill costs the manager's name width, so `mobile.css` gives it back the row gap and most of
its padding — without that, "Jamie Rogers" ellipsized to "Jamie Rog…" next to a `🔒 100%` pill.

## 2026-08-08 — Hot Takes read like a stat line: units, direction, and number density

Commissioner sent a screenshot of the morning's Hot Takes. The verdict was that it clearly reads
as Claude-written now (good — that was the point of the Sonnet path) but "a little clunky", "very
direct on numbers but doesn't say pts", and "unclear what the range is showing". Three separate
complaints, one root cause and two fixes.

**The root cause: the model echoes the shape of its evidence.** `commentaryFactSheet` handed over
bare decimals — `Jamie 401.4 (yesterday +3.1)`, `leads by 0.8` — so the takes came back full of
bare decimals: "Jamie's lead is down to 0.8 after Ryan S. clawed back 12.8 in one day." Both
numbers are correct and neither says what it is. A reader who does not already know the league
scoring cannot tell points from games from a batting average. So the units went into the FACTS,
not just into the rules: every figure in the fact sheet now carries `pts`.

**The range that showed nothing.** The worst line was `Freeman (8.9 to 3.3 a game)`. That is a
compression of the slump fact, and the compression is where the meaning died — two real numbers,
in the right order, with nothing saying which end is the player's form today. The fix is in the
phrasing of the evidence rather than a rule telling the model not to compress: the sheet now reads
`was 8.9 pts per game before this round, now 3.3 pts per game in it`. "Was … now" is carried by
words the model cannot drop without dropping a number too, so the direction survives any rewrite.
Heading changed to match: `PLAYERS GOING BACKWARDS (scoring rate BEFORE this round vs DURING it)`.

**The clunk.** Take 3 stacked three players and three parenthetical number pairs into one
sentence. Added a `HOW TO WRITE A NUMBER` block to the prompt covering four things: unit on the
first figure in a take and bare numbers after it (four `pts` in a sentence is its own kind of
clunky), never a bare two-figure range, at most two figures per sentence and three per take, and
an em dash rather than the hyphen it kept reaching for. Plus one instruction to read the take back
and cut it if it only parses as text on a screen.

**The bank got the same treatment**, because it is the floor the written takes fall back to and a
fallback that reads differently defeats the point of writing it in the same four voices. Every
score-driven bank line now names its unit, held there by a new sweep in
`tests/playoffCommentary.test.js`.

**Two tests worth keeping.** One walks every fact-sheet line and fails on a figure with no unit
attached — that is the property, stated once, rather than a dozen assertions on individual
strings. The other pins the slump line's direction (prior rate first, `was … before … now … in
it`), because the natural way to write that line is round-first and round-first is what produced
the ambiguous output.

No scoring, roster or manager logic was touched — this is entirely the wording of a derived
display. `commentaryFactSheet` is a `js/playoffCommentary.js` ↔ `server.js` mirror, so both copies
moved together and `tests/serverMirrors.test.js` confirms it.

## 2026-08-07 — Odds to advance in every round's final week, and the appearance-rate bug it exposed

Commissioner, the morning after the Slack-post rework: the playoff odds still need to show in the
final week of each round, with the % next to the manager names the way pool play had it. They
never appeared in the quarterfinals at all, and that was the thing to fix.

**Why they never appeared in QF.** They were never built to. The whole engine was scoped to
`ODDS_WINDOW = { round: 'PP2', firstWeek: 'Week 4', lastWeek: 'Week 5' }` and answered exactly one
question — "does this manager make the 8-team bracket". Once the bracket exists that question is
answered, so the section correctly rendered nothing. Nothing was broken by yesterday's changes;
the feature simply stopped at the bracket's door.

**What was added.** The same engine, asked the other question. In the FINAL week of QF/SF/Finals
it plays each head-to-head matchup out and reports the odds each side wins it — same projections,
same schedule-context adjustments, same Monte-Carlo draw, different definition of success.

1. `bracketOddsWindowForDate` reads "final week of the round" off `SEASON_SCHEDULE` rather than
   hardcoding `'Week 2'`, so adding a third week to a round moves the window instead of silently
   pointing at the wrong one. Pool play keeps its own untouched two-week window.
2. `simulateBracketOdds` (pure, unit-tested) draws both sides and counts matchup wins; an exact
   tie goes to the better seed, which is the rule the live bracket already applies.
3. Pairings come from `computePlayoffPairs` — the same function the matchup lines are built from —
   so a % can never describe a matchup the post doesn't show.
4. Stored as `sd.bracket_odds`, a derived cache in the same family as `sd.playoff_odds`: computed
   by the 4am sync and the 7am pre-post backstop, preserved on a full-season save, and only read
   at render time. `bracketOddsForPost` drops a payload whose date or round doesn't match the post
   being built, because a stale % beside a live score is worse than no %.

**Where the % went, and why not in its own section.** Inline on the matchup line, right after the
score: `▸ (1) Ada — 840 (+45) · 79%`, with one legend line under the section. That is the same
place pool play put it (next to the name it belongs to) and it is high in the post, above Slack's
"View Full Message" fold — a new section at the bottom is exactly what gets clipped. It also cost
about seven characters a line, so **no roasts had to be shortened**; the offer was there and
nothing needed to give.

**The real find: the projection had no concept of a player's playing time.** A per-game scoring
rate is a rate per APPEARANCE, and the engine multiplied it by the player's TEAM's remaining
games. That projects a starting pitcher to take every turn in the rotation, and it inflates a
pitcher-heavy roster relative to a bat-heavy one. It has been wrong since the engine shipped; it
just never showed, because pool play's window is long and everyone was inflated in the same
direction. In a two-week head-to-head it decides matchups.

`expectedAppearanceRate` estimates it from the player's own observed appearances, shrunk toward a
positional prior (0.85 batter / 0.3 pitcher) so a call-up lands on the prior instead of on 0 or 1.
`projectManager` applies it via the law of total variance —
`Var = f²(p·σ² + p(1-p)·μ²)` — so the appearance risk itself is carried, not just a scaled-down
mean. For a pitcher who may get two starts or three, that second term IS most of the uncertainty.
`p = 1` reduces the whole thing exactly to the old behavior, so the change is opt-in per player.

**And the bug inside the fix, which only a real run surfaced.** The first version used the team's
MLB-season `gamesPlayed` as the denominator. MLB starts in late March and the WMMC season starts
in May, so the numerator (appearances, from `daily_*` rows) covered ~81 days while the denominator
covered ~112 games — every everyday bat was filed as a 60% part-timer. Driving the real endpoint
against a synthetic QF-Week-2 season is what caught it: 104 projected appearances where the
fixture should have produced 137. `teamGamesInSpan` now derives games-per-day from the REMAINING
schedule (measured, not assumed; clamped to `[0.6, 1.0]`, the range a real MLB schedule lives in)
and applies it to the days we actually have stats for that player, so both halves cover the same
calendar. Re-run: 140 vs 137 expected.

**Lesson worth keeping: a rate and its denominator must be measured over the same span.** The
mistake is easy precisely because both numbers are individually correct — the team really did play
112 games, the player really did appear 66 times. Only the spans disagreed, and no unit test would
have caught it, because the unit was right.

**Also mechanized.** `tests/serverMirrors.test.js` now guards ten odds-engine functions as
`server.js` ↔ `js/playoffOdds.js` pairs. It paid for itself on the first run by catching a comment
that had gone missing from the server copy of `makeNormalSampler`. The two it can't cover are
`computeTeamQualityFactors` and `gameFactor`, which differ only in the name of the local clamp
helper (`server.js` must call it `oddsClamp`, a `clamp` already lives at its top level).

**Verification.** Booted the real server against a synthetic QF-Week-2 season with a local MLB API
stand-in, then drove the actual endpoints: `POST /playoff-odds/recompute` produced the payload
(every pair summing to 100.0%), `/wmmc` rendered the post with the % inline, and a second season
anchored one week earlier confirmed QF **Week 1** shows no odds and 409s the recompute. One
sharp edge worth remembering: **booting the server against a synthetic `db.json` rewrites the
committed `managers_seed.json`** with whatever managers that db holds. Check `git status` after
any local server run and revert it.

## 2026-08-06 — Playoff daily Slack post: matchup deltas, Claude-written Hot Takes, short manager names

Commissioner's complaint, mid-semifinals: the daily post's "Barely Competent / Monkeys Trying to
Fuck a Loose Couch" top-3/bottom-3 manager columns stop meaning anything once the bracket is down
to four teams — the two columns are just every surviving manager, sorted, with one matchup's
winners stacked against another's losers. Quarterfinals (eight teams) still reads fine.

**What changed, all in the daily scoreboard post.**

1. **Manager columns are dropped from the semifinals on** (`showManagerColumns`), kept for
   PP1/PP2/QF. The best/worst PLAYER columns are untouched in every round — they rank individual
   games, and there are always plenty of those.

2. **Each matchup line carries yesterday's movement** right after the round total:
   `▸ (8) Daniel — 83 (+3) _(B: 81 | P: 2)_`. `buildPlayoffMatchupsSlackText` gained an optional
   `dailyTotals`; the Monday wrap-up (`final: true`) never gets it, because a finished round has
   no "yesterday" worth reporting.

3. **New "🎙️ Hot Takes" section** — lead changes, blowouts, coin-flips, the day's biggest haul
   and deadest day, plus one career-pattern line. **Claude writes it; a deterministic bank is the
   floor.** See the correction below — I built the bank first on a wrong premise, and the API path
   went on top of it afterwards rather than replacing it.

4. **Short manager names on every Slack post** — first name, last initial only when two managers
   share one (`Ryan S.` / `Ryan C.`).

**The three decisions worth remembering.**

**Deltas are computed once, above the standings, not twice.** `computeDailyHighLow` already
returns an unsliced `managerTotals`; the post now calls it BEFORE building the matchup block and
feeds the same map to the matchup lines and to the commentary. A delta on a line and a delta a
roast talks about are the same number by construction, not by coincidence.

**The lead-change math needs a guard the numbers do not advertise.** "Did the lead change
overnight" is computed by subtracting yesterday's points back out of the round totals. That is
only valid while yesterday belongs to the round being reported — on the Monday of a new round,
yesterday's points sit in the PREVIOUS round, and subtracting them would invent a lead change out
of nothing. `yesterdayInRound` (against the round's own first/last schedule dates) gates the whole
feature; outside the window there are no deltas and no commentary, and the post degrades to what
it was before.

**Short names are applied at the SEND boundary, not in each builder.** `shortenManagerNamesInSlack`
runs inside `postSlack` / `postScoreboardSlack` / `postScoreboardChannelSlack`, so the prose posts
(swap notifications, elimination roasts, integrity alerts) inherit it without every template
learning about it. Two things this got right only on the second pass:

- The `/wmmc` slash command replies to Slack **directly** instead of going through
  `postScoreboardSlack`, so it needed the pass applied by hand or it would have been the one post
  in the channel still using full names.
- `Ryan S..` — a short name ending in an initial, followed by a sentence period. Caught in the
  live E2E render, not by any test. Fixed in two places, because there are two paths a name can
  reach a full stop by: `endSentence()` in the commentary templates (which receive short names
  directly), and a `\.?` swallow in the boundary regex (for prose that still holds full names).
  A 40-seed × 3-round × 4-shape sweep in `tests/playoffCommentary.test.js` now asserts no line
  ever contains `..`.

**Where the history came from, and the bug it exposed.** The "does he always lose in the
quarterfinals" material needs the finished-season record, which lived as a `const` inside app.js
where the server could not see it. Moved to **`js/history.js`** (canonical, unit-tested, bridged
onto `window` by js/index.js, deleted from app.js per the modularization rule) and mirrored into
server.js. Adding a season is now a two-file edit — noted in CLAUDE.md.

Deriving a manager's exit round per season reuses `js/playoffStatus.js`'s own ladder
(1st-2nd = Finals, 3rd-4th = lost the semi, 5th-8th = lost the quarterfinal, 9th+ = missed it),
so the commentary and the Hall of Fame agree about what a placing means.

Doing this surfaced a **pre-existing bug I did not fix**: the historical tables spell the
commissioner `Dan Kortan` while `db.managers` says `Daniel Kortan`, so the Hall of Fame's all-time
records treat them as two people and split that career in half. `js/history.js` has a
`HISTORICAL_NAME_ALIASES` map and applies it; the Hall of Fame does not read it yet. Flagged in
CLAUDE.md as a known bug with the fix already sitting in the module.

**CORRECTION, same day: production DOES have an `ANTHROPIC_API_KEY`.** I built the whole section
deterministic-only, citing the 2026-08-03 entry's conclusion that the key was unset. The
commissioner corrected me: it is set. That 2026-08-03 finding was an **inference from an
observation** — live QF roasts came back verbatim from the static bank, and I concluded the key
must be missing. The roasts have other reasons to land on the bank (a failed call, a timeout, a
bad status all fall back silently, and the bank is chosen for 17 of 110 template slots anyway), so
"output came from the bank" never proved "no key". **The lesson is the shape of the mistake, not
the fact: I turned an observation about OUTPUT into a conclusion about CONFIGURATION, and then a
later task inherited it as settled.** Anything about the deployed environment should be checked
against the Render dashboard, or asked, not inferred from behaviour that has more than one cause.

What changed as a result: `generatePlayoffCommentary` (server.js) writes the takes with Claude and
falls back to the bank on _every_ failure — no key, network throw, bad status, unreadable body,
empty reply, or a reply that quotes a score the evidence never contained. Three things made that
safe to do:

- **The model is handed facts, not data.** `commentaryFactSheet` (pure, in js/playoffCommentary.js)
  renders exactly what it may talk about — already-shortened names, both totals, both deltas, who
  led the previous morning, each survivor's career record. No season, no rosters, no path to them.
- **A reply that invents a score is rejected.** `commentaryMentionsUnknownScore` fails any decimal
  in the reply that is not in the fact sheet. Decimals only: whole numbers are ordinary prose
  ("8 seasons", "2 of 3"). This is the one failure that would actually mislead the league, because
  the section sits three inches under a real scoreboard.
- **The bank still runs first.** `buildScoreboardBlocks` stays synchronous (the `/wmmc` slash
  command owes Slack a reply in 3 seconds) and always renders the bank's version, tagged
  `block_id: wmmc_hot_takes`. `postScoreboardSlack` — the only async caller — swaps that block's
  text for the written version. A slow or failed call costs the post nothing.

Model is **Sonnet 5**, not the Haiku the elimination roasts use: this reply is several takes at
once, each anchored to a number printed a few lines above it, so being wrong is more expensive
than being cheap is valuable.

**One house voice, defined once, applied to every Claude-written roast.** The commissioner named
the references he wants the roasts to learn from: Stuart Scott, Norm Macdonald on Weekend Update,
Chris Rock, Shane Gillis. `ROAST_VOICE` (server.js, one const) is interpolated into **all five**
prompts — the Hot Takes, the elimination roast, the champion roast, the 3rd-place roast, and the
season-opening draft roast. One constant on purpose: a tone note that lives in one of five prompts
is how the other four drift, and the league should sound like the same guy all season.

The block asks for each comedian's **technique**, not their catchphrases — anchor swagger and
simile (Scott), a careful setup landing on a blunt understated punchline and committing to a dumb
bit (Macdonald), escalating repetition turning into an uncomfortable truth (Rock), loose
conversational riffing into an oddly specific scenario (Gillis) — plus an explicit "mix them, do
not do a clean impression of any one". "Be funny like X" without that gets a catchphrase and
nothing else. It also carries the line about what this league's meanness is: aimed at rosters,
picks and effort, never at family, looks, health or race, and never signed with a comedian's name.

**The Hot Takes fallback bank was rewritten in the same four voices** (commissioner asked for it
in the same breath), so a failed API call changes _who wrote the post_, not _how the league
sounds_. One line per voice per bank, which is why the banks are four long rather than three. The
banks now carry a comment listing the invariants the tests hold them to — every flip line says
"Lead change"/"flipped"/"New leader", every blowout and nailbiter interpolates `daysLeftText` and
the margin, and no line may ever contain `..` — because those are exactly the things a future
rewrite would break silently.

Still NOT rewritten: the **elimination-roast bank** (110 templates) and the daily worst-player
banks. Different feature, much bigger diff, and the elimination bank is full of the
`${roundLabel}` article traps documented on 2026-08-03 — a bulk rewrite there wants its own PR and
its own read-through, not a ride-along.

**The takes are cached for the day, and that is what makes `/wmmc` work.** A slash command has
three seconds to answer Slack, full stop — that limit is not configurable, and the usual escape
hatch (ack immediately, deliver later via the `response_url` Slack sends, valid 30 min / 5 posts)
would have `/wmmc` generating its OWN takes and putting a second, different set of jokes about the
same day in the channel. So instead: `ensureFreshHotTakes` generates at most once per `day|round`
and stores the result as `sd.hot_takes`, a derived cache in the same family as `sd.playoff_odds`
(preserved on a full-season save by the same defense). `buildScoreboardBlocks` prefers a matching
cache over the bank, so the sync path gets the written version for free. One API call a day, and
`/wmmc` and the 7am post can never disagree.

Two bugs found while wiring the endpoint, both pre-existing:

- `POST /api/slack/scoreboard` gated on `SLACK_WEBHOOK_URL` but posts via
  `SLACK_SCOREBOARD_WEBHOOK_URL`. A deploy with only the scoreboard webhook set got a 503 with
  nothing wrong; a deploy missing it got `{ok:true}` for a post `postScoreboardSlack` had
  silently dropped. Now checks whichever webhook is actually about to be used.
- The same endpoint did `readDB()` → post → `addAuditEntry(db)` → `writeDB(db)`. Harmless before,
  fatal now: the post writes `hot_takes` to its own fresh copy, and writing back the snapshot
  taken minutes earlier (from before an API call) erased them. It now re-reads before the audit
  write. This is the same shape as every clobber in this log — a db read held across slow work.

**`:tickets:` is not a Slack emoji, and only Slack could tell us.** The commissioner spotted it in
the first live post: two takes rendered 💥 and 💤, the third printed the literal text
`:tickets: 8 seasons. No Finals.` 🎫 is `:ticket:`, singular. Nothing in the toolchain can catch
this — it is valid JS, valid mrkdwn, passes every test, and is only wrong once Slack tries to draw
it. **The lesson is that Slack shortcodes are an external contract with no local validator**, same
category as a webhook URL or an emoji the workspace has not installed.

The fix is a written-down set, `SLACK_EMOJI`, and three uses of it: a test sweeps every line the
banks can produce and fails on anything outside it, a second test proves every entry is reachable
(so a dead entry or a broken rule shows up too), and the Anthropic prompt now lists the exact set
instead of giving examples. `enforceVettedEmoji` closes the last gap — a written reply that reaches
for an unlisted shortcode gets it swapped for `:zap:` rather than shipping literal text, because
the joke is the valuable part and the emoji is not.

Getting the reachability test to pass took a matchup shape I had not thought about: the big-day and
dead-day lines only fire when no earlier line has already named that manager, so proving they are
reachable needs a lead held all day, a margin between the nailbiter and blowout bars, and one
manager hauling while the other sleeps. Worth knowing that those two banks are the easiest to
accidentally make unreachable.

**A silent fallback is a bug, and it cost us an afternoon.** The first live posts came out in the
bank's voice. Nobody could say why, because the no-key path returned the bank with **no log line
at all** — a missing key, a rejected key, blocked egress and a bad model id were indistinguishable
from outside. Three changes:

- `generatePlayoffCommentary` now returns `{ lines, source }` and every fallback names its reason,
  once, at the point it happens. The reason is logged AND stored on `sd.hot_takes.source`, so the
  post itself carries a record of who wrote it.
- `GET /api/admin/anthropic-check` (commissioner only) asks the API a one-token question with the
  service's own key and reports unset / wrong / rejected / unreachable / working. It returns the
  key's length, last four characters and whether it matches `sk-ant-`, which separates "not set"
  from "set to the wrong thing" without putting a secret in an HTTP response.
- A forced re-roll now actually moves. It did not before, and that is the subtle one: the bank is
  seeded off the date so a repost tells the same joke — right for a retry, wrong for "give me
  different ones". `sd.hot_takes.rerolls` counts presses and nudges the seed by that count, so
  each re-roll lands on a different template while staying deterministic.

**What this says about the 2026-08-03 key finding.** The commissioner confirmed `ANTHROPIC_API_KEY`
IS set in the Render dashboard, and the Hot Takes still fell back — which means the Haiku
elimination roasts were failing for the same reason all along. Two different models, one
environment, both landing on their banks. So the 2026-08-03 entry reached a wrong conclusion
(`the key is unset`) from a real symptom, and my correction of it — `bank output does not prove a
missing key` — was right about the logic and did not find the actual cause either. The cause is
`data.content[0].text` — see the section below, which `anthropic-check` and the new logging found
within minutes of being deployed.

**FOUND IT: `data.content[0].text`.** The improved logging paid for itself on the first re-roll —
`[Hot Takes] Using the static bank: the API returned an empty reply`. HTTP 200, tokens billed, no
text. The cause is that every Anthropic caller in this app read `data.content[0].text`, which
assumes the first content block is the answer. **A model that emits a `thinking` block puts that at
index 0**, so `content[0].text` is `undefined` and the caller falls back to its template bank
having paid for a perfectly good reply.

Four call sites had it: the Hot Takes, the elimination roasts, the season-opening draft roast, and
(harmlessly) my own new diagnostic. Which resolves the thing this log has now been wrong about
twice:

- 2026-08-03 concluded "production has no `ANTHROPIC_API_KEY`" from roasts coming out of the bank.
- 2026-08-06 (above) corrected that to "bank output doesn't prove a missing key" — right about the
  logic, still didn't find the cause.
- The cause was this, all along. The key was set and valid the whole time; `anthropic-check`
  returned `ok: true`, 108-char key, model resolving, reply "OK".

The reason the diagnostic passed while the real call failed is itself the lesson: a 4-token
trivial prompt produces no thinking block, so `content[0]` IS the text. **A smoke test that
exercises a simpler path than production does can confirm everything and prove nothing.**

Fixed in `js/anthropic.js` (canonical, tested, mirrored): `anthropicReplyText` walks the whole
`content` array and joins every text block, and `describeAnthropicReply` reports block types,
`stop_reason` and token usage so an empty reply is never again unattributable. `max_tokens` on the
commentary went 600 → 4000, because thinking spends the same budget and at 600 the takes could be
truncated before a single text block existed.

**Confirmed in production**, 2026-08-06 17:08 ET, after deploying the fix:

```
[Hot Takes] Written by claude-sonnet-5: 4 take(s).
[Hot Takes] Stored 4 take(s) for 2026 SF 2026-08-05 — source: written, re-roll #2
```

First Claude-written post this app has ever produced. The elimination roasts and the
season-opening draft roast are fixed by the same commit and have never run against Claude either
— the next round end will read noticeably different from every previous one, which is worth
expecting rather than being surprised by.

**Second pass on the post, once it was live: fewer lines, better facts.** The commissioner's note
was "2 or 3 lines depending on what happened — if nothing too extreme, don't fill space for no
reason", plus catch-up pace, comparative scoring, and underperforming players. Note the tension:
fewer lines but more facts. That is the right shape — richer evidence, and the writer picks the
best two or three instead of padding to a quota.

- `commentaryBudget` counts what actually happened (a lead change is worth two on its own) and
  returns 2 or 3. Both the bank and the prompt honour it, and the prompt is told explicitly to
  write FEWER if the day does not justify them, and that every take must carry a fact the reader
  would not get from glancing at the scoreboard directly above it.
- `catchUpPace` gives the trailing manager's required per-day against what he has actually
  averaged — but only inside `RUN_IN_DAYS` (5) of the end, because a 200-pt gap with 12 days left
  is meaningless. **It returns a plain-English `verdict`, not just the ratio**, because "0.1x his
  own pace" means the chase is comfortable and a reader skimming for a punchline will see a small
  number and write a eulogy. State the conclusion; do not make the model infer it.
- Bracket-wide round totals, so a take can say "best of the four" without deriving it.
- `findUnderperformers` (server-side) reports players scoring materially less this round than
  before it. The attribution splits cleanly: WHOSE player he is comes from `activeRosterForOdds`
  (authoritative `roster_dates` windows, now round-parameterised), and HOW MUCH he scored is his
  own production from his own stat rows, which needs no ownership at all. Rates are per GAME, not
  per day — a batter with three games and a starter with one are not comparable per day.

**The bug that testing caught, and it is the reusable one.** Every gate in `findUnderperformers` is
a `>=` comparison, and **NaN fails every comparison**, so one unparseable stat line slipped past
all of them and reported a player whose rate had not moved as having collapsed. A guard written as
"skip if things look normal" fails OPEN on NaN; a guard written as "proceed only if things look
abnormal" fails closed. Insist on `Number.isFinite` before judging anybody. This would have put a
false accusation in the league channel.

**Line rules are gated on patterns, not incidents.** "He has never reached a Final" fires at 4+
seasons; "he always goes out in the quarterfinals" needs 3+ QF exits AND the current round to be
the quarterfinals. And in the Finals the two games mean opposite things — "this is the closest he
has been to a Final" is pointed for a championship-game player and simply false for somebody in
the 3rd-place game, who already lost his semi. Each history rule is therefore evaluated with its
candidate's own matchup label in context.

**New: `tests/serverMirrors.test.js`.** This change added two more `js/` ↔ `server.js` duplicate
pairs to a codebase whose recurring failure mode is exactly that drift. The test reads server.js
as text and fails if a mirrored block no longer matches its `js/` original. It runs no server code
(so it does not violate "no tests for server.js"), and it already covers the pre-existing
`normalizeName` pair. Extending it to `SCORING` / `detectScoreSwings` / the odds engine is the
obvious next win.

**Verified E2E, not just unit-tested.** Both commentary paths. A synthetic season generator (real manager names, invented
players) plus a local webhook sink: booted the real `server.js` against a QF / SF / Finals / PP2
fixture in turn and POSTed `/api/slack/scoreboard`, then read the captured blocks. Confirmed the
manager columns present in QF and PP2 and absent in SF and Finals, an engineered overnight lead
change reported as one, a 233-pt blowout reported as one, deltas on every matchup line, pool play
byte-for-byte unchanged in structure, and the `/wmmc` reply carrying short names. The `Ryan S..`
bug only ever showed up here — a reminder that for Slack work the render is the test that counts.

For the API path: ran the same fixture with a **present but invalid** key and confirmed a real 401
from `api.anthropic.com` (so outbound connectivity works from a container, which is also evidence
Render can reach it) left the post byte-identical to the no-key one. Then drove
`generatePlayoffCommentary` itself against canned replies with a stubbed `fetch` — clean reply used
as-is; bullets, `**bold**` and `Ryan S..` cleaned up; an invented `99.7` rejected to the bank; and
empty / 500 / network-throw / unreadable-body all falling back. Note the _success_ path has never
run against the real API from here — there is no key in this container — so the first live post is
the real test of prompt quality, though not of safety.

**Gotcha for the next fixture builder:** `computeEffectiveBattingScore` recomputes a weekly score
from the daily rows whenever daily rows exist for that week, so a fixture with ONE day of daily
data reports round totals equal to that single day, no matter what `weekly_score` says. The first
fixture looked broken for exactly this reason. Give the round at least two dated days (a lump for
"everything before yesterday" plus yesterday) or the lead-change math has nothing to work with.

## 2026-08-06 — Deleting a dormant fallback is a risk decision, not a cleanup

Follow-on from the audit entry below. The audit's headline finding was "the Google Sheets sync is
~1,160 dead lines with zero frontend callers — the largest single cleanup available." I offered
that to the commissioner as a cleanup option, he picked it, and I deleted it. Both halves of that
sentence were wrong.

### The number was wrong, and the reason generalises

`server.js` has a `// Google Sheets Sync` banner at 6153. I measured the block from the banner to
the end of `syncGoogleSheets` and called the whole thing importer code. It is not. Living under
that banner are `buildWeekRostersFromDates` (the canonical roster derivation — the core scoring
invariant by function), `syncPlayerDatesFromRosterDates`, `recomputeMidWeekAddScores`,
`repairGhostInitialRosterPlayers` and the three `findManagerForPlayer*` attribution helpers.

Actual importer-only code was ~700 lines, and I only learned that by resolving callers for every
function in the range. **A section header is not a dependency graph.** Measure a deletion by who
calls what, never by which comment banner it sits under.

### The bigger miss: unreachable is not unwanted

`RUNBOOK.md` has a "Break glass: re-enable Google Sheets sync" section. It states plainly that the
sync is a **dormant server-side fallback**, that there is intentionally no UI, and that the
endpoints and parsers stay in `server.js` so it can be re-armed if the MLB API is ever
unavailable. I found that section while rewriting docs — _after_ deleting the code it describes.

Everything I had used as evidence of deadness was actually evidence of it being deliberately
dormant: no UI, no caller, force-disabled at boot. Those were the design, documented in the file
whose whole job is telling you what to do in an emergency. The MLB Stats API is the single point
of failure for a stats-scoring app; "it is untested and needs an API key" is an argument for
exercising a fallback, not for deleting it.

The commissioner pushed back — "why would we remove the break glass path? it's specifically there
in case of emergency" — and he was right. Restored in full.

### The process failure, which is the part to actually remember

I obtained consent on a framing that later turned out to be false, then kept going. When the RUNBOOK
section surfaced, the honest move was to stop and re-ask, because "delete dead code" and "remove
the emergency fallback for our single point of failure" are different questions with different
answers. Instead I finished the deletion and flagged the tradeoff afterwards, which puts the
commissioner in the position of having to un-approve something already built.

> **If what you discover mid-task changes what the user was actually agreeing to, stop and
> re-ask. Flagging it afterwards is not the same thing.**

### What survived, and why it was worth doing anyway

The coupling underneath was the real defect, and it is what nearly cost us the fallback.
`google_sheets_config.season` was the app-wide current-season pointer — the daily scoreboard post,
the season welcome post, the 4am MLB sync, the `/wmmc` slash command, the player-pool bootstrap and
the auto-advance scheduler all resolve from it — and `POST /api/google-sheets/config` was its only
writer. That is two hazards in one: re-arming the fallback in an emergency could silently repoint
the whole app, and any cleanup aimed at the importer takes the season pointer with it.

Now: `db.active_season`, an `activeSeason(db)` accessor (falls back to the legacy location, then
the calendar year, so a pre-migration Upstash restore still resolves correctly), a boot migration,
and `GET`/`POST /api/admin/active-season` as a real writer that rejects a nonexistent season. The
gsheets config endpoint no longer accepts `season` at all. The importer is untouched.

### Verifying a fallback means arming it

Testing that the app still boots proves nothing about a path that is off by default. Booted a
second time with `google_sheets_config` fully populated to confirm `[GSheets] Auto-sync enabled`,
that `/api/google-sheets/sync-status` responds, and that `{"season":"2025"}` posted to the config
endpoint leaves `active_season` at `2026`.

That is also how `eslint` earned its keep: the regex that rewrote the 12 read sites had collapsed a
`const config` declaration the `sync-status` handler still used. It would have 500'd that endpoint
the moment anyone checked the fallback — during an outage, which is the only time anyone would.

### Housekeeping done in the same session

- **`MEMORY.md` split** (#427). 230 KB / 3,158 lines / 82 entries, read at session start. Entries
  from 2026-07-29 stay; the older 46 moved to `MEMORY-ARCHIVE.md`; an index of all 82 sits at the
  top. Cutoff chosen so every entry about the live playoff period stays loaded.
- **Docs corrected** (#426). `DATA_REPAIRS.md` listed four repairs that no longer exist; both plan
  docs still said "proposal for review"; `tests/fixtures/README.md` claimed `db.sample.json` was
  committed "so every Claude session has current league data" — that file has never existed on any
  branch, the Action's Upstash secrets were never added.
- **`staging` refreshed.** It was 240 commits behind while `render.yaml` still auto-deploys
  `wmmc-staging` from it. No unique files, so it was merged and resolved to main's tree; verified
  the tree hash matches `origin/main` exactly.
- **57 stale branches deleted** by the commissioner. Agent sessions get HTTP 403 on ref deletion —
  pushes work, deletes do not. Hand the command over rather than reporting it as done.

### Endpoints: still 13 with no caller, still not dead

The audit below lists them. Re-confirmed the reasoning by reading each: `/api/mlb/apply-corrections`
fronts `sweepStatCorrections`, which the nightly scheduler calls directly (`server.js:15873`), and
`resync-dryrun`/`backfill-unscored` shipped the day before the audit. Four genuinely superseded ones
went: `dedupe-repair-swaps` (its trigger was deleted in #252), `test-guard-alert`, and
`name-check`/`name-fix` — that last pair worth removing on safety grounds, since `name-fix` does
fuzzy auto-renames at a caller-supplied threshold with no totals vet while `/api/mlb/roster-fix`
(#307) does the same job keyed on `sd.mlb_ids` with a before/after totals comparison.

## 2026-08-06 — Repo-wide PR/branch/dead-code audit, and why no endpoint was deleted

Reviewed all 425 PRs (none open), all 60 remote branches, and cross-referenced every route,
export and doc against the tree. Three docs were wrong; the code was cleaner than expected.

### Fixed here (docs only)

- **`DATA_REPAIRS.md` listed four repairs that no longer exist.** `repairMissingSwapRecords` and
  `repairMissingRosterChains` went in #252 (Phase 3b); `purgeBoundaryAutoAdvance` and
  `purgeGhostHerreraFromJoey` went in #423. Only `purgeCarriedForwardDropRecords` and
  `applyMLBApiTakeover` remain gated. Retired rows now move to a **Retired** table instead of
  being deleted, so a recurrence starts from "already fixed once".
- **Both plan docs still said "proposal for review"** though every phase shipped.
  `SAVE_HARDENING_PLAN.md` → delivered (#286/#288/#290/#251/#252); `ROSTER_OPS_PLAN.md` →
  delivered (3a/3b #322, 3c #323, clamp+undo #324).
- **`tests/fixtures/README.md` claimed `db.sample.json` "is committed so every Claude session and
  every unit test has current league data".** It has **never existed on any branch** — the
  Action's Upstash secrets were never added. Any agent trusting that line goes looking for real
  league data that isn't there. The README now says so and documents how to generate it. The
  tooling itself (`scripts/sanitize-db.js`, `refresh-fixture.sh`, the workflow) works fine and
  was kept.

### Branches: all 58 non-`main` branches are retirable

Every `claude/*` branch's PR is merged. Three (`mobile-display-optimization-eb437p`,
`season-accolades-stats-z6dw9n`, `swaps-log-dropdowns-mobile-2vgq8v`) only _look_ unmerged
because they predate the history rewrite — `main`'s root `60f78c1` is a squash of everything
through #339, so they share no merge base. `live-tab-ownership-filter-jik50j` is #374, the one
closed-unmerged PR, superseded by #425. `tmp/hook-signing-probe` is a throwaway probe.
`staging` is 820 commits behind and still the deploy target of the `wmmc-staging` Render
service — refresh it or retire the branch and the `render.yaml` block together.

Deletion could not be done from an agent session: pushes succeed but ref deletions get HTTP 403.

### The endpoint audit — 17 routes with no caller, and why they stay

Cross-referencing the 88 routes against `app.js`, `index.html`, `RUNBOOK.md` and `README.md`
turns up 17 with no caller anywhere. **"No HTTP caller" is not "dead"**, and this is the second
time that heuristic has misfired here (see the 2026-08-05 scope correction above):

- `/api/mlb/apply-corrections` delegates to `sweepStatCorrections`, which **the nightly scheduler
  calls directly** (server.js:15873). The route is the manual door onto live machinery.
- `apply-corrections`, `resync-dryrun` and `backfill-unscored` were all added **the day before
  this audit** (#409, #413). They are commissioner tooling awaiting a UI, not residue.
- The boundary/roster repair routes (`rebuild-roster-arrays`, `reconstruct-rosters`,
  `reconcile-boundary-rosters`, `purge-orphan-boundary-rosters`) rebuild derived caches from
  `roster_dates` — the canonical derivation. They are **generic repairs**, which the operative
  rule says to keep.

Genuinely incident-specific and plausibly retirable, for a human who knows whether they still get
curl'd during incidents: `dedupe-repair-swaps` (dedupes repair-swaps written by repairs that no
longer exist), `reseed-approved-boundary-rosters` (the 2026-06-08 clobber), `test-guard-alert`,
`name-check`/`name-fix` (superseded by the roster-audit/roster-fix UI in #307), `recent-stats`,
`rollup-audit`. Left alone deliberately — that call needs operational knowledge, not a grep.

### Google Sheets: ~1,160 dead lines, with a live wire through them

> **Both claims in this heading are wrong — see the 2026-08-06 entry above
> ("Deleting a dormant fallback is a risk decision, not a cleanup").** The importer-only code is
> ~700 lines, not 1,160: the `// Google Sheets Sync` banner at 6153 also covers
> `buildWeekRostersFromDates` and the attribution helpers, which are core. And it is not dead —
> `RUNBOOK.md` documents it as the deliberate break-glass fallback for an MLB API outage. It was
> deleted on the strength of this paragraph and then restored. Left here, corrected rather than
> rewritten, because the wrong reasoning is the useful part.

`applyMLBApiTakeover` force-sets `enabled = false` at boot and strips `source: 'gsheets'` rows.
The engine is still fully present with **zero** frontend callers: server.js:6153–7151 (sync
engine), 7153–7236 (the four endpoints), 14835–14860 and 15144–15195 (scheduler). But
`google_sheets_config.season` is the **app-wide current-season pointer** (read in 10 places) and
`POST /api/google-sheets/config` is its **only writer**. `RUNBOOK.md` already warns about this.
Extract the pointer to `db.active_season` first — done in #428, which also leaves the importer
in place.

### Verified clean — don't re-audit these

- Every must-stay-in-sync duplicate pair matches: `SCORING` (identical keys and values),
  `SEASON_SCHEDULE` (16 entries, `round`/`week` exact, `label` only on the `js/` side as
  intended), `ROUND_LABELS`, `detectScoreSwings`, `checkSwapLimit`, `projectManager`,
  `gameFactor`, `currentQualification`. `computeTeamQualityFactors` differs only by a local alias
  (`oddsClamp` vs `clamp`) — not drift.
- `app.js` has **no dead functions** — all 329 declarations are referenced. #421 did that job.
- `js/index.js`'s window bridge has no stale entries.
- The five "exported but never imported" `js/` constants (`ELIMINATION_ROUND_ORDER`,
  `UNSCORED_BATTING_KEYS`, `UNSCORED_PITCHING_KEYS`, `ODDS_DEFAULT_SIMS`,
  `PLAYOFF_STATUS_LABELS`) are all used **inside their own module**, and two are halves of
  documented server mirrors. Dropping `export` would be noise. Left alone.

### Still open

- `MEMORY.md` is 230 KB / 3,158 lines and `CLAUDE.md` says to read it at session start — the
  largest recurring context cost in the repo. Worth splitting into recent + `MEMORY-ARCHIVE.md`.
- `CNAME` (`wmmc.live`) and `.nojekyll` are GitHub Pages mechanisms; the app deploys on Render.
  Probably vestigial — confirm Pages isn't serving the apex domain before removing.

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

> **SUPERSEDED 2026-08-06 — finding 2 below is WRONG.** Production **does** have an
> `ANTHROPIC_API_KEY` set; the commissioner confirmed it. The reasoning below ("all four live
> roasts came back verbatim from the static bank, therefore the key is unset") does not hold: a
> failed call, a timeout and a bad status all fall back to the bank silently, and the bank is the
> intended path for 17 of 110 template slots anyway. Bank output never proved a missing key. If
> the live roasts really are all coming from the bank, the cause is something else — worth
> checking the Render logs for Anthropic errors rather than the dashboard for a missing variable.
> Finding 1 (the article bug) is unaffected. See the 2026-08-06 Hot Takes entry.

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
