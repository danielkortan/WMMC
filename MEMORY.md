# WMMC — Decisions Log

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
