# Whit Merrifield Memorial Cup (WMMC)

## What this project is

WMMC is a full-stack fantasy baseball league management app used by a private league. It manages multi-season scoring, weekly roster swaps with commissioner approval, a playoff bracket, and daily stat syncing from the MLB Stats API (with a Google Sheets fallback). Commissioners run the league through a built-in admin panel; managers view standings, rosters, and trends on the same single-page app.

See README.md for full feature list, API reference, and deployment instructions.

## Tech stack — use these, do not suggest alternatives

Always use the tools below. If you genuinely think the wrong tool was chosen for a task, flag it once, then proceed with the stack unless I say otherwise.

- **Language:** JavaScript (ES2021) — no TypeScript
- **Runtime:** Node.js 22+ (required — the `js/` ESM modules live in a CommonJS package and only load via Node's module syntax detection, which is unflagged from Node ~20.19/22+; older versions cannot run the tests)
- **Frontend:** Vanilla JS — `app.js` monolith being incrementally modularized into `js/`; Chart.js loaded from CDN
- **Backend / API:** Express 4.x (`server.js`)
- **Database:** File-backed `db.json` via synchronous `fs`; optional Upstash Redis backup for Render deploys
- **Auth:** Per-request email/password check against `db.json` (no sessions)
- **Styling:** Monolithic `styles.css` — no framework
- **Testing:** Node.js built-in test runner (`node --test`)
- **Package manager:** npm
- **Hosting / deploy:** Render.com (`render.yaml`)
- **Linting/Formatting:** ESLint 10 (flat config, `eslint.config.js`) + Prettier 3

## Commands

- Install: `npm install`
- Start: `npm start`
- Test (all): `npm test`
- Test (one file): `node --test tests/scoring.test.js`
- Lint: `npm run lint`
- Lint fix: `npm run lint:fix`
- Format: `npm run format`
- Format check: `npm run format:check`
- Run before committing: `npm run lint && npm run format:check`

No watch mode — restart `npm start` manually after backend changes.
The pre-push hook in `.githooks/pre-push` auto-stamps `version.json` with today's date. Never skip it with `--no-verify`.

## Architecture in one paragraph

Express backend in `server.js` handles all API routes, the scoring engine, MLB Stats API sync, Google Sheets sync, and Slack notifications. State lives in `db.json` (read and written synchronously on every request) and is mirrored to Upstash Redis on every write. The frontend is a single-page app: `index.html` loads `app.js` (a monolith being incrementally modularized) plus extracted `js/` modules. There is no build step — static files are served directly by Express. Auth is stateless: `X-User-Email` and `X-User-Password` headers are re-validated against `db.json` on every mutating request.

## Where things live

- `server.js` — Express backend: all API routes, scoring engine, MLB Stats API sync, Google Sheets sync, Slack
- `app.js` — Frontend monolith (being incrementally modularized — do not duplicate logic already moved to `js/`)
- `index.html` — Single-page app shell
- `styles.css` — Core styles (monolithic); `mobile.css` — mobile/responsive overrides (both loaded by `index.html`)
- `js/` — Extracted frontend modules: `scoring.js` (scoring + `SCORING`/`SEASON_SCHEDULE` + weekly-team enrichment), `playoffOdds.js` (Monte-Carlo playoff-odds engine), `hypothetical.js` (the What If sandbox engine — client-only, never writes), `seeding.js` (pool-play seeding rule, shared by the real bracket and the What If playoff picture), `bracket.js` (playoff pairings + tie-breaks, used by the What If bracket), `history.js` (the finished-season record + per-manager career facts — mirrored in `server.js`), `playoffCommentary.js` (the daily playoff post's "Hot Takes" — pure, mirrored in `server.js`, no frontend caller yet), `lateSubmission.js` (when a roster submitted after its period's lock takes effect — pure, mirrored in `server.js`), `roundPreview.js` (the round-end post's next-round preview — pure, mirrored in `server.js`, server-only caller), `csv.js`, `utils.js`, `index.js` (bridges exports onto `window` for `app.js`), `mobile.js` (side-effect mobile UI behaviors — not unit-tested)
- `tests/` — Unit tests for pure `js/` modules only
- `db.json` — Runtime database (gitignored); written by server on every mutation
- `managers_seed.json` — Committed manager identities (no passwords); seeds `db.json` on fresh deploy
- `data.json` — Historical seed data (read-only)
- `render.yaml` — Render.com deploy config
- `.githooks/` — Git hooks (pre-push stamps `version.json`)

## Permanent project facts

These are always true. Apply to every session. If a task conflicts with one, flag it before proceeding.

- **THE CORE SCORING INVARIANT (this is the heart of the app — protect it above all else).** A
  manager's score is the sum, over each player they roster, of the points that player earns **only
  within that player's roster window** (`add_date` → `drop_date`), within the **period** (PP1/PP2/
  QF/SF/Finals) they were rostered for. Consequences that are non-negotiable:
  - **Source of truth for "who is rostered, when" = `roster_dates` + approved `swaps` (date
    windows), scoped to the period.** A new submission period starts fresh from its submission;
    players do **not** carry across a period boundary. Use `periodStartForRound` to scope
    carry-forward.
  - **Managers** come from **one place only: the commissioner page (`db.managers`)**. That is the
    canonical manager list; every other view must read managers from it, never invent or infer them.
  - **Players enter a roster only via** an initial/period **submission** or a **swap** (including a
    commissioner swap) — always stamped with a **date and a period identifier**. Nothing else may
    add a player to a roster.
  - `sd.rosters` (per-week arrays), the `manager` field on `weekly_*`/`daily_*` rows, and weekly
    rollups are **derived caches** — rebuild them from the date windows; never treat them as
    authoritative (the sticky stat-row `manager` is NOT swap-honored).
  - Every view (scoreboard, Slack, Live tab, swap form, exports) must read managers and the
    date-windowed rosters **completely, every time** — no partial/stale snapshots.
  - **Any change touching managers, player lists, roster windows, swaps, or scoring must be vetted
    with a before/after per-manager totals comparison** (see `SAVE_HARDENING_PLAN.md` §7) and must
    state how it preserves this invariant. The full-season save is clobber-prone; prefer the atomic
    endpoints (`/submissions`, `/swaps`) and never wipe a server-authoritative field from a client
    payload.
- `SCORING` and `SEASON_SCHEDULE` are hardcoded in **both** `server.js` and `js/scoring.js` and must be kept in sync — every edit goes in both files. (They were moved out of `app.js` during modularization; `app.js` now reads them from `window`, populated by `js/index.js`.)
- Never commit `db.json` — it is gitignored and contains passwords.
- `managers_seed.json` stores manager identities but never passwords — the server strips passwords before writing it.
- The frontend has no build step — `index.html` loads files directly; there is nothing to compile or bundle.
- Once a function is moved to `js/`, delete its copy from `app.js` — do not let both coexist.

## Git workflow

- **Always open a pull request for every change — never push to `main` directly.** This is the standard process for this repo: develop on a feature branch, push it, and open a PR so changes are reviewed and CI runs before they reach production. (`render.yaml` auto-deploys `main` on merge, so a merged PR _is_ a production deploy.)
- Open the PR as soon as the branch is pushed and the work is ready for review — don't wait to be asked. After opening one, offer to watch it for CI failures and review comments.
- Keep PRs focused: one logical change per PR, with a clear title and a body summarizing what changed and why.
- Do not merge your own PR unless explicitly told to — opening it is the deliverable; merging is the maintainer's call. **Exception: docs-only PRs** (`MEMORY.md`, `ERRORS.md`, `README.md`, `RUNBOOK.md`, the `*_PLAN.md` files — no code, no config) — merge those yourself once `check` is green, no need to ask. Anything that touches `server.js`, `app.js`, `js/`, `styles.css`, `index.html`, `render.yaml` or `package.json` still waits for the maintainer, because merging deploys it.
- **`main` is protected.** Merging requires the **`check`** status check (the job in `.github/workflows/ci.yml` — tests + lint + format) to pass, and the PR branch must be up to date with `main` first. If `main` moves while a PR is open, merge/rebase `main` into the branch before the merge button enables. If you ever rename the CI job, update the required-check name in the branch protection rule to match, or merges will block on a check that never reports.

## Conventions and patterns

- **Error handling:** Route handlers return `{ error: '...' }` JSON with an appropriate HTTP status code. Never swallow errors silently.
- **Logging:** Plain `console.log` / `console.error` — no abstraction layer.
- **Naming:** camelCase for variables and functions.
- **Imports:** CommonJS `require()` in `server.js` and `app.js`; ES module `export`/`import` in `js/` modules. Do not mix the two styles within a file.
- **Testing philosophy:** Unit-test pure logic in `js/`. There are no e2e tests. Do not write tests for `server.js` or `app.js` directly.

## Gotchas — things that look wrong but aren't

- `detectScoreSwings` exists in **both** `js/scoring.js` (canonical, unit-tested) and `server.js` (the only runtime caller). Like `SCORING`/`SEASON_SCHEDULE`, the two copies must stay identical — edit both. The server can't import the ESM `js/` copy.

- The odds engine (`ODDS_WINDOW` through `formatOddsPct`, including the schedule-context adjustments `HOME_ADVANTAGE`/`PARK_FACTORS`/`computeTeamQualityFactors`/`gameFactor` and the appearance-rate model `APPEARANCE_PRIORS`/`expectedAppearanceRate`) exists in **both** `js/playoffOdds.js` (canonical, unit-tested) and `server.js` (the runtime caller: 4am compute, 7am Slack post, recompute endpoint). Same rule: edit both — and `tests/serverMirrors.test.js` now mechanizes it for every function whose two copies are byte-identical. (`computeTeamQualityFactors` and `gameFactor` are the exceptions it can't cover: they differ only in the name of the local clamp helper, which `server.js` has to call `oddsClamp` because a `clamp` already lives at its top level.) The server-only glue (`collectPlayerGameLog`, `teamGamesInSpan`, `fetchOddsScheduleContext`, `buildOddsContext`, `projectRosterForOdds`, `activeRosterForOdds`, `fetchTeamIdAbbrevMap`, `fetchRemainingGamesByTeam`, `fetchTeamSeasonQuality`, `computePlayoffOddsForSeason`, `ensureFreshPlayoffOdds`, `buildPlayoffOddsSlackText`, `computeBracketOddsForSeason`, `ensureFreshBracketOdds`, `bracketOddsForPost`) lives only in `server.js`. `PARK_FACTORS` is a hand-maintained multi-year-average table (not live data) — review it each season, especially the Athletics (`ATH`/`OAK`) and Rays (`TB`) entries, which are left neutral pending their current home-park situation being confirmed.

- **The engine answers two different questions, in two non-overlapping windows.** PP2 Weeks 4–5 → "does he make the bracket", stored as `sd.playoff_odds`, rendered as its own `🔮 Playoff Odds` section and as the scoreboard pill. A bracket round's FINAL week (QF/SF/Finals Week 2, read off the schedule by `bracketOddsWindowForDate` rather than hardcoded to 'Week 2') → "does he win his matchup", stored as `sd.bracket_odds`, rendered inline on each Slack matchup line by `buildPlayoffMatchupsSlackText` **and on each row of the scoreboard's Playoff Bracket card** (`advanceOddsHtml` inside `buildActivePlayoffBracket`, app.js). Both are server-computed derived caches — clients only display them, and the full-season save always keeps the server's copy. The bracket pairings come from `computePlayoffPairs`, the same function the matchup lines are built from, so a % can never be about a matchup the post doesn't show. `bracketOddsForPost` drops a payload whose date or round doesn't match the post being built, because a stale % beside a live score is worse than no %; `advanceOddsHtml` applies the same gate client-side and additionally requires the payload's `opponent` to match the name across the bracket row, because that card derives its pairs itself (seeding + prior-round winners) rather than from `computePlayoffPairs`.

- **Appearance rate is why a projection is not "his team's remaining games".** A per-game scoring rate is a rate per APPEARANCE, so multiplying it by team games projects a starting pitcher to take every turn. `expectedAppearanceRate` corrects it from the player's own observed appearances, shrunk toward a positional prior. The denominator matters more than it looks: it must be measured over the SAME span as the numerator, which rules out the team's MLB season game count (MLB starts in late March, the WMMC season in May — a full-season denominator over a WMMC-season numerator files every everyday bat as a part-timer). `teamGamesInSpan` therefore derives games-per-day from the REMAINING schedule and applies it to the days we have stats for that player. `projectManager` carries the appearance risk into the variance via the law of total variance, not just the scaled-down mean — for a pitcher who may get two starts or three, that is most of the uncertainty.

- `checkSwapLimit` (+ `FREE_SWAP_REASON`/`PLAYOFF_LIMITED_REASONS`) exists in **both** `js/swaps.js` (canonical, unit-tested; the swap form's pre-check) and `server.js` (the enforcing copy at swap submission). Same rule as `detectScoreSwings`: the two copies must stay identical — edit both. **`SWAP_REASON_LABELS`/`swapReasonLabel` in the same file are a mirrored pair too** (guarded by `tests/serverMirrors.test.js`), because the Slack swap notification renders the same label as the menus — the league must never see one name for a swap type in the app and another in Slack. They map the STORED reason to what a manager reads (`'IL Swap'` → `'IL/RST Swap'`); the stored string never changes, since every historical swap in `db.json` carries it and `checkSwapLimit`, the server's IL gate and the audit log all key off it. Relabel there, never rename the value — and apply the label only at display sites, never where a reason is compared or persisted. Relatedly, the client's `getCurrentScheduleRound` (app.js) and the server's `currentScheduleRound` implement the same round-detection rule (between weeks → the upcoming round) and must stay in step.

- **A LATE roster submission is not a special case in the scoring engine — it is just a later
  `add_date`.** `js/lateSubmission.js` (canonical, unit-tested) ↔ `server.js`, on the same
  must-stay-identical footing as the pairs above and guarded by `tests/serverMirrors.test.js`. The
  rule: submit before the day's first pitch → effective TODAY; after it → TOMORROW; never before
  the period starts, never past its end (null = no viable day left). That date becomes every
  player's `add_date` when the commissioner approves, so `managerWeekSubtotal` and
  `rebuildRosterArraysFromDates` clip the window with the machinery they already have. **The
  SERVER decides both "is this late" and "which date"** (`resolveSubmissionWindow`, exposed as
  `GET /api/seasons/:year/submission-window/:period`, and stamped onto the record by
  `POST /submissions`): it needs today's real first pitch from the MLB Stats API and a clock the
  manager cannot set, and the date is the scoring invariant's own unit — a manager choosing it
  after reading a box score is the whole thing this prevents. app.js keeps `getPeriodDeadline`
  for instant rendering and the plain open/closed question, but late mode renders off
  `SUBMISSION_WINDOWS`, the server's answer. **"Beg Commish for Forgiveness"** files the roster
  with `forgiveness_status: 'pending'` and NO effective date; `POST .../forgiveness` is the only
  path that can start a roster earlier than the automatic rule, which is why it is
  commissioner-only and validated against the period's own bounds. Approving a late submission
  that has no effective date is blocked client-side (`blockLateApprovalWithoutDate`) — without
  that guard it would silently fall back to the period start, i.e. a free back-date.

- `SCORING` and `SEASON_SCHEDULE` appear in both `server.js` and `js/scoring.js`. This is intentional — the server needs them for score recomputation and Slack posts; the client needs them for live scoring. They must stay identical. (`app.js` consumes the `js/scoring.js` copy via `window`, so it is no longer a third source of truth.) The one permitted difference: the `js/scoring.js` entries carry a `label` for the UI and the `server.js` ones do not — `round` and `week` must match exactly.
- `ROUND_LABELS` is a fourth `server.js` ↔ `js/scoring.js` duplicate, on the same must-stay-identical footing as the three above. (Not to be confused with `app.js`'s `ROUND_LABELS_FOR_ROAST`, which is keyed by bracket stage, where Pool Play is one thing.)

- **`tests/serverMirrors.test.js` mechanizes the "edit both copies" rule** for the pairs it covers — it reads `server.js` as text and fails if a mirrored block has drifted from its `js/` original. It runs no server code. When you intentionally change a mirrored helper, change it in `js/` too and the test goes green again. It currently guards `normalizeName`, `shortManagerNames`, `shortenManagerNamesInSlack`, `js/history.js`, `js/playoffCommentary.js`, `js/roundPreview.js`, the elimination ladder (`lastRoundPlayed`/`isManagerActiveInRound`/`isManagerInRound` from `js/eligibility.js`) and ten functions of the odds engine; extending it to the remaining older pairs (`SCORING`, `detectScoreSwings`) would be a straight win. It has already earned its keep — adding the odds-engine pairs immediately caught a comment that had gone missing from the `server.js` copy of `makeNormalSampler`.

- `js/history.js` (canonical, unit-tested) ↔ `server.js` — `WMMC_HISTORICAL_RESULTS` plus `managerPlayoffHistory`/`exitStageForPlace`/`canonicalManagerName`. Same must-stay-identical rule. **Adding a finished season is now a two-file edit**: the table in `js/history.js` (which `app.js` reads off `window` for the Hall of Fame — it no longer holds its own copy) and the mirror in `server.js` (which the daily playoff Slack commentary reads). `HISTORICAL_NAME_ALIASES` maps a manager's old spelling to their current `db.managers` name (`Dan Kortan` → `Daniel Kortan`); the Hall of Fame does **not** apply it yet, so its all-time records still split that career in two — a real bug, just not this file's.

- `js/anthropic.js` (canonical, unit-tested) ↔ `server.js` — `anthropicReplyText` / `describeAnthropicReply`. **Never read `data.content[0].text`.** A model that emits a `thinking` block puts it at index 0, so `content[0].text` is `undefined`, the call looks empty, and the caller silently ships its static fallback on an HTTP 200 with tokens billed. That is exactly what happened to the daily Hot Takes, the elimination roasts and the season-opening roast — for months, and it is what the 2026-08-03 entry misread as a missing `ANTHROPIC_API_KEY`. Walk the `content` array and join every text block; `anthropicReplyText` does. When it comes back empty, log `describeAnthropicReply(data)` — the block types, `stop_reason` and token usage are what tell a refusal apart from a `max_tokens` cut-off mid-thinking. Keep `max_tokens` generous for the same reason: thinking spends the same budget.

- **Only three rounds eliminate anyone: Pool Play, the Quarterfinals and the Finals.** The
  SEMIFINALS do not. Its two winners play the Championship, its two losers play the 3rd-place
  game, and both games run over the SAME two Finals weeks — so all four semifinalists submit a
  Finals-period roster and all four keep scoring. `lastRoundPlayed` (`js/eligibility.js` ↔
  `server.js`) is where that lives: it maps a stored `sd.eliminated[m] === 'SF'` forward to
  'Finals' on READ, so seasons transitioned before this was understood behave correctly without
  a data migration. Nothing should ever write `sd.eliminated[m] = 'SF'` again — the SF transition
  is `advanceToFinalsAndThirdPlace` (app.js), which deletes no submission, marks nobody
  eliminated, and clears stale 'SF' markers and roasts when re-run. The server enforces it
  independently: the round-end post clears its roast set for `round === 'SF'` rather than
  trusting the caller.

- `js/roundPreview.js` (canonical, unit-tested) ↔ `server.js` — the round-end post's forward-
  looking section (`buildRoundPreviewBlock` and friends). Same must-stay-identical rule, guarded
  by `tests/serverMirrors.test.js`. Pure: it is handed already-derived facts and only shapes
  them, so it can't disagree with the scoreboard. The server-only glue that feeds it
  (`buildNextRoundPreview`, `topBracketPerformers`) lives in `server.js`, takes its pairings from
  `computePlayoffPairs` — the same function the results block above it uses — and scores top
  performers through `managerWeekSubtotal` rather than the `sd.rosters` cache. Its two trailing lines are
  labelled (`_History:_ …`) rather than wrapped whole in italics, which is now a style choice
  rather than a workaround — the `\b`-vs-underscore bug that made it necessary was fixed in
  `shortenManagerNamesInSlack` itself.

- `js/playoffCommentary.js` (canonical, unit-tested) ↔ `server.js` — the "Hot Takes" line banks and the lead-change/blowout/history rules on the daily playoff post, plus `commentaryFactSheet` / `commentaryMentionsUnknownScore` / `tidyCommentaryLine`, which are the pure half of the Anthropic path. Pure throughout: it is handed already-derived facts, so it can never disagree with the scoreboard about a score. Same must-stay-identical rule.

- **`ROAST_VOICE` (server.js) is the house voice for every Claude-written roast** — the daily Hot Takes, the elimination/champion/3rd-place roasts, and the season-opening draft roast all interpolate the same const. Tone references are Stuart Scott, Norm Macdonald on Weekend Update, Chris Rock and Shane Gillis, asked for as technique rather than catchphrases, with an explicit "never name, impersonate or sign as them". If you add a new Claude-written roast, interpolate `ROAST_VOICE` into its prompt — that is the whole point of it being one constant. **Emoji shortcodes are an external contract with no local validator** — Slack prints an unknown one as literal text, and `:tickets:` shipped to the league that way (🎫 is `:ticket:`). `SLACK_EMOJI` in `js/playoffCommentary.js` is the vetted set: a test sweeps every line the banks can produce, a second proves every entry is reachable, the Anthropic prompt lists the set verbatim, and `enforceVettedEmoji` swaps anything unlisted out of a written reply. Add to the list only after confirming the shortcode renders in Slack. The Hot Takes fallback bank in `js/playoffCommentary.js` is written in the same four voices, one line per voice per bank, so an API failure changes who wrote the post rather than how the league sounds — keep that property when adding lines. The OLDER banks (the 110-template elimination-roast bank, the daily worst-player roasts) are not in this voice yet.

- **Hot Takes has two paths and the order matters.** `buildScoreboardBlocks` is synchronous (the `/wmmc` slash command owes Slack a reply in 3 seconds), so it always renders the deterministic bank and tags the block `block_id: wmmc_hot_takes`. `postScoreboardSlack` — the only async caller — then swaps that block's text for `generatePlayoffCommentary`'s Anthropic-written version. Every failure (no key, network, bad status, unreadable body, empty reply, or a reply quoting a decimal the fact sheet never contained) returns the bank text, so the swap becomes a no-op and the post is never harmed. Never make `buildScoreboardBlocks` async to "simplify" this — the slash command is what the sync path exists for. The bridge between them is `sd.hot_takes`, a server-computed derived cache keyed on `day|round` (same family as `sd.playoff_odds`, and preserved on a full-season save the same way): `ensureFreshHotTakes` generates at most once per day and stores it, and `buildScoreboardBlocks` prefers a matching cache over the bank — which is how `/wmmc` shows the written takes at all. When the takes come out in the bank's voice, `GET /api/admin/anthropic-check` (commissioner only) answers why in one call instead of waiting for a post — it makes a one-token request with the service's own key and reports unset / wrong / rejected / unreachable / working, without ever returning the key. Every fallback also names its reason in the logs (`[Hot Takes] Using the static bank: …`) and records it on `sd.hot_takes.source`. `POST /api/slack/scoreboard` takes `refreshTakes: true` to force a re-roll and `channel: "notifications"` to rehearse a post into the notifications channel; the latter is the ONLY supported override of the scoreboard webhook, and it is explicit for a reason (an implicit fallback into the swaps channel is a bug this repo has already had). The commentary runs on `PLAYOFF_COMMENTARY_MODEL` (Sonnet 5), deliberately not the Haiku the elimination roasts use: these takes sit directly under a real scoreboard and quote its numbers.

- `shortManagerNames` **and `shortenManagerNamesInSlack`** are `js/utils.js` ↔ `server.js` pairs, like `normalizeName` (both mechanized in `tests/serverMirrors.test.js`). Slack posts get short names at the **send boundary** (`shortenManagerNamesInSlack` inside `postSlack` / `postScoreboardSlack` / `postScoreboardChannelSlack`, plus the `/wmmc` slash-command reply, which answers Slack directly and would otherwise be missed), so prose posts — swap notifications, elimination roasts, alerts — inherit it without every builder having to know. The pass is whole-name, therefore idempotent; a short name ending in an initial swallows a following period so nothing prints `Ryan S..`. **Its boundary is spelled out (`NAME_EDGE = '[A-Za-z0-9]'`), not `\b`, and that is deliberate**: `\b` counts underscore as a word character, underscore is Slack's italic marker, and so `_Ryan Sullivan_` matched at neither end — a name at the head of an italic run was the one mention in a post that stayed long while every other mention of the same manager went short. If you ever reach for `\b` here again, `tests/utils.test.js` will fail. Its one remaining blind spot is a manager who shares a full name with an MLB player — nobody in this league does, and the damage would be a cosmetic short name on a player row.

- **The IL-swap gate reads MLB roster status CODES, and the code list is not guessable.** `IL_SWAP_ELIGIBLE_STATUS_CODES` (`server.js`) is `D7`/`D10`/`D15`/`D60`/`ILF`/`RA`/`RST`. Verified against the live API, and re-verifiable with `node scripts/mlb-roster-status.js --sweep`, which prints every status code in use league-wide with the gate's verdict for each — use it rather than reasoning about what a code probably means. Two traps it exists to prevent: **`RM` is "Reassigned to Minors"** (300 players), not the Restricted List, which is **`RST`** (28); and `ILF` ("Injured - Full Season", 240 players) used to clear the gate only through the `/injured/i` description fallback, never through the code set — that regex is still there as a catch-all for codes MLB adds later, but nothing should depend on it again. `RA` ("Rehab Assignment") counts because a rehabbing player has not been activated off the IL.

- `app.js` and `js/` coexist during the modularization migration. `index.html` still loads `app.js` directly. This is expected until the migration is complete.
- `db.json` is absent from a fresh clone. The server seeds it automatically from `managers_seed.json` on first start.
- The pre-push hook rewrites `version.json` on every push. This is intentional — it forces browsers to fetch fresh assets after a deploy.

## Do / Don't

**Do:**

- Run `npm run lint && npm run format:check` before considering any task done
- Open a pull request for every change — branch, push, PR; never push to `main` directly (see Git workflow)
- Update tests when changing public function signatures in `js/`
- Add new third-party libraries only if confirmed — list alternatives first

**Don't:**

- Don't add new dependencies without asking.
- Don't duplicate logic between `app.js` and `js/` — if a function exists in `js/`, call it from there and remove the copy in `app.js`.
- Don't commit `db.json`.
- Don't edit `SCORING` or `SEASON_SCHEDULE` in only one file — both `server.js` and `js/scoring.js` must be updated together.
- Don't skip the pre-push hook (`--no-verify`).
- Don't push directly to `main` or merge without a PR — every change goes through a pull request.

## Passphrases / triggers

- **`SCOREFIX`** — the user pastes this (or says "the score-swing guard fired" / "scoring swing
  Slack alert") when PR #247's score-swing guard posts a Slack alert. The guard blocks ≥40-pt
  drops and warns on >200-pt jumps.
  **Walk them through it entirely inside the chat — do NOT tell them to open `RUNBOOK.md` or
  navigate anywhere.** Paste, inline in your reply, the full self-contained code they need:
  1. A single copy-paste console block that installs the `wmmc.*` helpers **and immediately runs
     `wmmc.dates()`** (combine install + first read so they get the saved-totals table in one
     paste). The canonical helper source is `RUNBOOK.md` → "Score-swing guard fired" — copy it
     verbatim, don't rewrite it from memory.
  2. Ask them to paste back the `wmmc.dates()` table (and `wmmc.mgr("<manager>")` for the flagged
     manager). Give the exact `wmmc.mgr(...)` line to paste.
  3. From the table, give them the exact `wmmc.diff("<lastGood>","<bad>")` line (dates filled in)
     to find the manager → week → player that moved.
  4. Decide with them: legit MLB correction → `wmmc.forceSync()` (give the exact call); bad
     data → diagnose the roster/swap/date and propose the fix. Always hand them ready-to-run
     code, never a pointer to docs.

## Memory files

- `MEMORY.md` — decisions log. Read at session start. Append on meaningful decisions and at session end. It opens with an **index of every entry ever written**, including the archived ones — read the index, then read only the entries you need.
- `MEMORY-ARCHIVE.md` — the same log, for entries older than the cutoff at the top of `MEMORY.md`. Not read at session start. **Search it before concluding something is new or unexplored** — most "why is this like this" answers live here. When `MEMORY.md` grows unwieldy again, move the oldest entries across and regenerate the index; never delete an entry.
- `ERRORS.md` — what didn't work and what did. Check before proposing approaches to similar problems. (Does not exist yet — create it when first needed.)
