# The Whit Merrifield Memorial Cup (WMMC)

A full-stack fantasy baseball league management application with multi-season support, Google Sheets stat sync, and a complete playoff bracket system.

## Features

- **Multi-Season Management** — Create, manage, and archive multiple seasons
- **Configurable Scoring** — Per-stat batting and pitching point rubrics (currently hardcoded; see [Scoring Rubric](#scoring-rubric))
- **Roster Management** — Per-week rosters with a manager-initiated swap workflow that auto-applies on submission: the server enforces per-round swap limits (pool play: one Free Swap per PP round, unlimited IL/Drop/Trade; playoffs: one Free/Drop/Trade swap per round, unlimited IL), verifies IL swaps against the player's official MLB injured-list status, and computes effective dates from the live schedule (a player whose game has started swaps effective tomorrow). Swaps the integrity guard flags fall back to commissioner review; the commissioner can undo any applied swap
- **MLB Stats API Sync** — Source of truth for stats: automatic 4am-Eastern daily delta + Wednesday full-week correction, with manual backfill/rebuild/diagnostic tools in the commissioner panel
- **Google Sheets Sync** — Dormant server-side fallback (no UI); re-enable via API only if the MLB feed is unavailable — see [RUNBOOK.md](RUNBOOK.md)
- **Playoff Bracket** — Pool play seeding feeds quarterfinals, semifinals, finals, and a 3rd-place game
- **Playoff Odds** — During PP2 Weeks 4–5, a Monte-Carlo simulation (per-player per-game scoring rates × each team's remaining MLB games, run against the pool-winner/wild-card rules) shows every manager's likelihood of making the playoffs on the scoreboard and in the daily Slack post
- **Hypothetical Zone ("What If")** — A read-only sandbox for every manager. The **Scoring Lab** changes what any stat is worth (including three batting stats and one pitching stat that are recorded but currently unscored) and rescores the standings instantly. The **Roster Lab** swaps who a manager started for a whole period and shows it beside what they actually had, side by side, then reports whether the change alters who makes the playoffs (using the league's real seeding rule). A manager who never reached a round can enter a roster for it to score the round they didn't play. The **Player Explorer** looks up any player who recorded a stat — rostered or not — with a per-game log, per-round totals scored both ways, and who actually held him. The **Playoff Picture** shows pool play by pool with each period's winners and the wild cards, then re-seeds and re-pairs the bracket under the scenario; where a promoted manager never played a round it says so rather than inventing a result. Runs entirely in the browser against a snapshot — no write path to league data, and an unmodified scenario reproduces the live scoreboard exactly. Scenarios are shareable by link
- **Trends & Analytics** — Season-long Chart.js visualizations per manager and player
- **Hall of Fame** — All-time records across past seasons
- **Commissioner Panel** — Roster overrides, manager management, stat uploads, season setup, swap log with undo (plus approvals for guard-flagged swaps), audit log
- **Slack Integration** — Optional webhooks for swap notifications and a daily scoreboard post. Manager names are shortened to first names (with a last initial when two managers share one). During the playoffs the post leads with the bracket matchups, each manager's round total carrying yesterday's movement as a delta, and closes with **Hot Takes** — lead changes, collapses, the day's biggest haul, and the career pattern a survivor is carrying, drawn from the finished-season record in `js/history.js`. Claude writes the takes from a fact sheet of those numbers when `ANTHROPIC_API_KEY` is set (a reply quoting a score the facts don't contain is rejected); a deterministic template bank in the same voice is the floor when it isn't, or when the call fails. The day's takes are generated once and cached on the season, so `/wmmc` — which must answer Slack within three seconds and therefore cannot call an API — shows the same takes as the morning post rather than a second set of jokes about the same day. From the semifinals on, the best/worst _manager_ columns are dropped (four teams is not a leaderboard); the best/worst _player_ columns stay all season

## Tech Stack

- **Backend:** Node.js + Express, file-backed JSON store with optional Upstash Redis backup
- **Frontend:** Vanilla JS (single-file, currently being modularized — see [Project Structure](#project-structure))
- **Charts:** Chart.js (loaded from CDN)
- **Auth:** Email/password against `db.json`, with optional Google Sign-In (set the `GOOGLE_CLIENT_ID` env var)

## Getting Started

### Prerequisites

- Node.js 18 or newer

### Installation

```bash
git clone <repo-url>
cd WMMC
npm install
```

### Configuration

All configuration is via environment variables (no `.env` loader is bundled — set them in your shell or in `render.yaml` for deployments).

| Variable                       | Default        | Description                                                                                                                                  |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | `3000`         | HTTP port                                                                                                                                    |
| `LOGIN_PASSWORD`               | `Welcome2Hell` | Global fallback password used when a manager has no per-account password set                                                                 |
| `DB_PATH`                      | `./db.json`    | Path to the runtime JSON database. On Render, point this at a persistent disk mount.                                                         |
| `UPSTASH_REDIS_REST_URL`       | _(unset)_      | Optional. When set, `db.json` is mirrored to Upstash so it survives ephemeral redeploys.                                                     |
| `UPSTASH_REDIS_REST_TOKEN`     | _(unset)_      | Auth token paired with `UPSTASH_REDIS_REST_URL`.                                                                                             |
| `SLACK_WEBHOOK_URL`            | _(unset)_      | General notifications channel (swaps, sync errors).                                                                                          |
| `SLACK_SCOREBOARD_WEBHOOK_URL` | _(unset)_      | Channel for the daily scoreboard post. Required for it — no fallback to `SLACK_WEBHOOK_URL`.                                                 |
| `SLACK_SIGNING_SECRET`         | _(unset)_      | Required if you wire up the `/api/slack/command` slash command.                                                                              |
| `ANTHROPIC_API_KEY`            | _(unset)_      | Optional. Enables AI-written elimination roasts and the daily playoff "Hot Takes"; unset (or any API failure) falls back to a template bank. |
| `GOOGLE_CLIENT_ID`             | _(unset)_      | Optional. OAuth 2.0 Web client ID — enables "Sign in with Google" (see below).                                                               |

### Running

```bash
npm start
```

Open `http://localhost:3000` in your browser.

### Development

```bash
npm run lint          # Run ESLint on server.js, app.js, and js/
npm run lint:fix      # Auto-fix what ESLint can fix
npm run format        # Format the entire repo with Prettier
npm run format:check  # Verify formatting without writing
npm test              # Run unit tests for the js/ modules
```

## Scoring Rubric

The rubric is hardcoded in **two places that must stay in sync**: `js/scoring.js` (`SCORING` constant, consumed by `app.js` via `window`) and `server.js` (`SCORING` constant). Any edit must be applied to both files.

### Batting

| Category          | Points |
| ----------------- | ------ |
| Singles (1B)      | 3      |
| Doubles (2B)      | 5      |
| Triples (3B)      | 8      |
| Home Runs (HR)    | 10     |
| Runs (R)          | 2      |
| RBIs              | 2      |
| Stolen Bases (SB) | 5      |
| Walks (BB)        | 2      |

### Pitching

| Category                      | Points |
| ----------------------------- | ------ |
| Wins (W)                      | 4      |
| Quality Starts (QS)           | 4      |
| Complete Games (CG)           | 2.5    |
| Complete Game Shutouts (CGSO) | 2.5    |
| No-Hitters (NH)               | 5      |
| Innings Pitched (IP)          | 2.25   |
| Hits (H)                      | -0.6   |
| Earned Runs (ER)              | -2     |
| Walks (BB)                    | -0.6   |
| Strikeouts (K)                | 2      |

## Season Structure

A season is 16 scoring weeks plus a midseason break.

1. **Pool Play 1** — 5 weeks (Weeks 1–5)
2. **Pool Play 2** — 5 weeks (Weeks 6–10)
3. _All-Star Break_ (no scoring)
4. **Quarterfinals** — 2 weeks (Weeks 11–12)
5. **Semifinals** — 2 weeks (Weeks 13–14)
6. **Finals + 3rd-Place Game** — 2 weeks (Weeks 15–16)

The schedule is hardcoded in `js/scoring.js` (`SEASON_SCHEDULE`, consumed by `app.js` via `window`) and `server.js` (`SEASON_SCHEDULE`).

## API Reference

All endpoints return JSON. Endpoints that read state are unauthenticated; endpoints that mutate state perform their own per-request password/role checks.

### Auth

| Method | Endpoint                               | Description                                                                             |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST` | `/api/login`                           | Validate `{ email, password }`. Returns `{ ok, manager }` or 401.                       |
| `GET`  | `/api/auth/config`                     | Public. Returns `{ googleClientId }` (empty when Google login is off).                  |
| `POST` | `/api/auth/google`                     | Verify a Google ID token `{ credential }`. Returns `{ ok, manager, token }` or 401/403. |
| `POST` | `/api/managers/:email/change-password` | Manager self-service password change.                                                   |

### Seasons

| Method   | Endpoint                                    | Description                                                           |
| -------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `GET`    | `/api/seasons`                              | All seasons keyed by year.                                            |
| `POST`   | `/api/seasons`                              | Replace the entire seasons map.                                       |
| `POST`   | `/api/seasons/:year`                        | Save a single season.                                                 |
| `DELETE` | `/api/seasons/:year/week-data`              | Wipe a single week's uploaded stats for a season.                     |
| `POST`   | `/api/seasons/:year/recompute-scores`       | Recompute weekly scores from scratch.                                 |
| `POST`   | `/api/seasons/:year/playoff-odds/recompute` | Recompute & store playoff odds now (only valid during PP2 Weeks 4–5). |

### Player Dates & Daily Stats

| Method   | Endpoint                          | Description                                              |
| -------- | --------------------------------- | -------------------------------------------------------- |
| `GET`    | `/api/seasons/:year/player-dates` | Per-player add/drop dates.                               |
| `POST`   | `/api/seasons/:year/player-dates` | Save player dates.                                       |
| `DELETE` | `/api/seasons/:year/player-dates` | Clear player dates.                                      |
| `GET`    | `/api/seasons/:year/daily-stats`  | Daily stat snapshots used for mid-week add/drop scoring. |
| `POST`   | `/api/seasons/:year/daily-stats`  | Append daily stats.                                      |
| `DELETE` | `/api/seasons/:year/daily-stats`  | Clear daily stats.                                       |

### Managers

| Method   | Endpoint                        | Description                                                                |
| -------- | ------------------------------- | -------------------------------------------------------------------------- |
| `GET`    | `/api/managers`                 | All manager records (passwords stripped).                                  |
| `POST`   | `/api/managers`                 | Replace the manager list.                                                  |
| `POST`   | `/api/managers/:email/password` | Commissioner sets a manager's password.                                    |
| `DELETE` | `/api/managers/:email/password` | Commissioner clears a manager's password (falls back to `LOGIN_PASSWORD`). |

### Current-season pointer

| Method | Endpoint                   | Description                                                            |
| ------ | -------------------------- | ---------------------------------------------------------------------- |
| `GET`  | `/api/admin/active-season` | Which season the automations act on, and which seasons exist.          |
| `POST` | `/api/admin/active-season` | Repoint them. Body `{ season }`; rejects a season that does not exist. |

### Google Sheets Sync

| Method | Endpoint                         | Description                             |
| ------ | -------------------------------- | --------------------------------------- |
| `GET`  | `/api/google-sheets/config`      | Returns sync config; API key is masked. |
| `POST` | `/api/google-sheets/config`      | Save sync config.                       |
| `POST` | `/api/google-sheets/sync`        | Trigger a manual sync.                  |
| `GET`  | `/api/google-sheets/sync-status` | Last sync status, errors, timestamp.    |

### Slack

| Method | Endpoint                          | Description                                                                                                                                                                                                                                                       |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/admin/anthropic-check`      | Commissioner only. Asks the Anthropic API a one-token question with this service's key and reports exactly what came back — unset, wrong, rejected, unreachable, or working. Never returns the key itself. Optional `?model=` to test a different model id.       |
| `POST` | `/api/slack/scoreboard`           | Manually trigger the scoreboard Slack post. Optional body: `year`; `channel: "notifications"` to rehearse it into the notifications channel instead of the league one; `refreshTakes: true` to regenerate the day's Hot Takes instead of reusing the cached ones. |
| `POST` | `/api/slack/command`              | Slash-command webhook (verified via `SLACK_SIGNING_SECRET`).                                                                                                                                                                                                      |
| `POST` | `/api/seasons/:year/roasts/slack` | Post the playoff field, a roast for every manager eliminated in a round, and next-round submission instructions as one combined message to the scoreboard channel; generates any missing roast first. Body: `{ round, qualifiers?, eliminated?, regenerate? }`.   |

### Misc

| Method | Endpoint             | Description                                           |
| ------ | -------------------- | ----------------------------------------------------- |
| `GET`  | `/api/pending-count` | Count of pending swap requests across active seasons. |
| `GET`  | `/api/audit-log`     | Recent audit entries. Query: `?limit=50`.             |
| `GET`  | `/api/banner-config` | Custom banner background config.                      |
| `POST` | `/api/banner-config` | Save banner config.                                   |
| `POST` | `/api/heartbeat`     | Online-user heartbeat. Body: `{ email, name }`.       |
| `GET`  | `/api/online-users`  | Currently online users.                               |

## Google Sheets Setup

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **Google Sheets API**.
3. Create an API key under **APIs & Services → Credentials**.
4. In your spreadsheet, create tabs named `Week 1 Batting`, `Week 1 Pitching`, `Week 2 Batting`, etc.
5. Re-arm the sync via the API — there is intentionally no UI. See [RUNBOOK.md](RUNBOOK.md) → "Break glass: re-enable Google Sheets sync".

## Google Sign-In Setup

Lets managers log in with their Google account instead of a password. Each manager
has a **Google Email** field (editable in the Commissioner panel) that the Google
account's verified email is matched against; it defaults to the manager's league
email, so it works out of the box and only needs changing when a manager signs in
with a different Google address than their league email. (If the field is blank,
the league email is used.) Email/password login keeps working either way, and the
Google button stays hidden until `GOOGLE_CLIENT_ID` is set.

1. Create (or reuse) a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com).
2. Under **APIs & Services → OAuth consent screen**, configure the consent screen (External; add yourself as a test user, or publish it).
3. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Web application**.
4. Add **every origin the page loads from** under **Authorized JavaScript origins** — Google matches them exactly (scheme + host, no path or trailing slash, https only except localhost). For this league that's `https://wmmc.live` (and `https://www.wmmc.live` if the `www.` host also resolves), plus `http://localhost:3000` for local dev. Add `https://wmmc.onrender.com` only if anyone reaches the app directly via the Render URL. No redirect URI is needed (Google Identity Services uses the JS callback).
5. Copy the generated **Client ID** and set it as the `GOOGLE_CLIENT_ID` env var (in your shell locally, or in the Render dashboard for deploys).

**How it works:** the browser obtains a signed Google ID token; the server verifies
its signature against Google's public keys (built-in `crypto`, no extra dependency),
confirms the audience matches `GOOGLE_CLIENT_ID`, maps the verified email to a manager,
and issues a per-manager auth token. The client then sends that token like a password,
so Google users get the same access (roster swaps, commissioner panel) as password users.

## Project Structure

```
WMMC/
├── server.js              # Express backend (routes, scoring, sheets sync, slack)
├── app.js                 # Frontend monolith — currently being modularized into js/
├── index.html             # Single-page app shell
├── styles.css             # Core styles (monolithic; will move to css/)
├── mobile.css             # Mobile/responsive style overrides (loaded after styles.css)
├── data.json              # Historical 2025 season data (read-only seed)
├── managers_seed.json     # Committed manager identities (no passwords)
├── db.json                # Runtime database (gitignored, written by server)
├── version.json           # Build version stamp updated by .githooks/pre-push
├── render.yaml            # Render.com deployment config
├── package.json           # Dependencies & npm scripts
├── eslint.config.js       # ESLint configuration (flat config)
├── .prettierrc.json       # Prettier configuration
├── .githooks/
│   └── pre-push           # Auto-stamps version.json with today's date
├── js/                    # New modular frontend (extracted from app.js — work in progress)
│                          #   scoring.js, csv.js, utils.js — pure logic (unit-tested)
│                          #   hypothetical.js — What If sandbox engine (pure, read-only)
│                          #   seeding.js — pool-play seeding rule (real bracket + What If)
│                          #   bracket.js — playoff pairings and tie-breaks (What If bracket)
│                          #   anthropic.js — Messages API reply shape (never index content[0])
│                          #   history.js — finished-season record + per-manager career facts
│                          #   playoffCommentary.js — daily playoff post "Hot Takes" (server-only caller)
│                          #   index.js — bridges module exports onto window for app.js
│                          #   mobile.js — side-effect mobile UI behaviors (not unit-tested)
└── tests/                 # Tests for pure js/ modules, plus serverMirrors.test.js, which
                           # fails if server.js drifts from a js/ module it duplicates
```

> **Note on ongoing modularization:** The frontend has historically been a single `app.js` file. We're incrementally extracting pure logic (scoring, CSV parsing, utilities) into `js/` modules, with matching tests in `tests/`. Until the migration is complete, both layers co-exist: `index.html` still loads `app.js` directly, and the extracted modules are exercised through `tests/`. Do not duplicate logic between layers — once a function is in `js/`, delete its sibling in `app.js` and call into the module via `<script type="module">`.

## Deployment

The app is configured for [Render.com](https://render.com) via `render.yaml`. The disk mount at `/var/data` keeps `db.json` across deploys. Set `LOGIN_PASSWORD` and `SLACK_WEBHOOK_URL` as secret env vars in the Render dashboard, and verify `DB_PATH=/var/data/db.json` so writes land on the disk (not the ephemeral fallback) — the `Storage` button in the commissioner MLB panel reports the live path and whether durable storage is active.

> **Note on Upstash:** the `UPSTASH_*` backup mirrors a **slim** copy of `db.json` to Upstash — full league/standings state minus the regenerable per-game `daily_batting`/`daily_pitching` rows (the multi-MB bulk), which keeps the payload under Upstash's ~1 MB request-size limit (`slimForBackup` in `server.js`). The server writes a live `wmmc_db` key plus rolling dated `wmmc_db_bak_<YYYY-MM-DD>` snapshots (~14-day TTL); restore them in-app via `GET /api/admin/db-backups` and `POST /api/admin/db-restore`. The **persistent disk remains the source of truth** — Upstash is disaster recovery only. Because the backup is slim, a restore brings back standings immediately but needs an MLB backfill (`POST /api/mlb/backfill`) to repopulate per-game daily detail. If the slimmed payload still exceeds the limit (`[Upstash] … exceeds the … limit` in the logs), trim further before relying on it. Before enabling `UPSTASH_*` in production, verify a real prod-sized `db.json` serializes under the limit.
