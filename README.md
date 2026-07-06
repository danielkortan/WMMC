# The Whit Merrifield Memorial Cup (WMMC)

A full-stack fantasy baseball league management application with multi-season support, Google Sheets stat sync, and a complete playoff bracket system.

## Features

- **Multi-Season Management** — Create, manage, and archive multiple seasons
- **Configurable Scoring** — Per-stat batting and pitching point rubrics (currently hardcoded; see [Scoring Rubric](#scoring-rubric))
- **Roster Management** — Per-week rosters with a manager-initiated swap workflow that the commissioner approves
- **MLB Stats API Sync** — Source of truth for stats: automatic 4am-Eastern daily delta + Wednesday full-week correction, with manual backfill/rebuild/diagnostic tools in the commissioner panel
- **Google Sheets Sync** — Dormant server-side fallback (no UI); re-enable via API only if the MLB feed is unavailable — see [RUNBOOK.md](RUNBOOK.md)
- **Playoff Bracket** — Pool play seeding feeds quarterfinals, semifinals, finals, and a 3rd-place game
- **Playoff Odds** — During PP2 Weeks 4–5, a Monte-Carlo simulation (per-player per-game scoring rates × each team's remaining MLB games, run against the pool-winner/wild-card rules) shows every manager's likelihood of making the playoffs on the scoreboard and in the daily Slack post
- **Trends & Analytics** — Season-long Chart.js visualizations per manager and player
- **Hall of Fame** — All-time records across past seasons
- **Commissioner Panel** — Roster overrides, manager management, stat uploads, season setup, swap approvals, audit log
- **Slack Integration** — Optional webhooks for swap notifications and a daily scoreboard post

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

| Variable                       | Default                           | Description                                                                              |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`                         | `3000`                            | HTTP port                                                                                |
| `LOGIN_PASSWORD`               | `Welcome2Hell`                    | Global fallback password used when a manager has no per-account password set             |
| `DB_PATH`                      | `./db.json`                       | Path to the runtime JSON database. On Render, point this at a persistent disk mount.     |
| `UPSTASH_REDIS_REST_URL`       | _(unset)_                         | Optional. When set, `db.json` is mirrored to Upstash so it survives ephemeral redeploys. |
| `UPSTASH_REDIS_REST_TOKEN`     | _(unset)_                         | Auth token paired with `UPSTASH_REDIS_REST_URL`.                                         |
| `SLACK_WEBHOOK_URL`            | _(unset)_                         | General notifications channel (swaps, sync errors).                                      |
| `SLACK_SCOREBOARD_WEBHOOK_URL` | falls back to `SLACK_WEBHOOK_URL` | Channel for the daily scoreboard post.                                                   |
| `SLACK_SIGNING_SECRET`         | _(unset)_                         | Required if you wire up the `/api/slack/command` slash command.                          |
| `GOOGLE_CLIENT_ID`             | _(unset)_                         | Optional. OAuth 2.0 Web client ID — enables "Sign in with Google" (see below).           |

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

### Google Sheets Sync

| Method | Endpoint                         | Description                             |
| ------ | -------------------------------- | --------------------------------------- |
| `GET`  | `/api/google-sheets/config`      | Returns sync config; API key is masked. |
| `POST` | `/api/google-sheets/config`      | Save sync config.                       |
| `POST` | `/api/google-sheets/sync`        | Trigger a manual sync.                  |
| `GET`  | `/api/google-sheets/sync-status` | Last sync status, errors, timestamp.    |

### Slack

| Method | Endpoint                | Description                                                  |
| ------ | ----------------------- | ------------------------------------------------------------ |
| `POST` | `/api/slack/scoreboard` | Manually trigger the scoreboard Slack post.                  |
| `POST` | `/api/slack/command`    | Slash-command webhook (verified via `SLACK_SIGNING_SECRET`). |

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
5. Enter the spreadsheet URL and API key in the Commissioner panel under **Stats Data → Google Sheets Auto-Sync**.

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
│                          #   index.js — bridges module exports onto window for app.js
│                          #   mobile.js — side-effect mobile UI behaviors (not unit-tested)
└── tests/                 # Tests for pure js/ modules
```

> **Note on ongoing modularization:** The frontend has historically been a single `app.js` file. We're incrementally extracting pure logic (scoring, CSV parsing, utilities) into `js/` modules, with matching tests in `tests/`. Until the migration is complete, both layers co-exist: `index.html` still loads `app.js` directly, and the extracted modules are exercised through `tests/`. Do not duplicate logic between layers — once a function is in `js/`, delete its sibling in `app.js` and call into the module via `<script type="module">`.

## Deployment

The app is configured for [Render.com](https://render.com) via `render.yaml`. The disk mount at `/var/data` keeps `db.json` across deploys. Set `LOGIN_PASSWORD` and `SLACK_WEBHOOK_URL` as secret env vars in the Render dashboard, and verify `DB_PATH=/var/data/db.json` so writes land on the disk (not the ephemeral fallback) — the `Storage` button in the commissioner MLB panel reports the live path and whether durable storage is active.

> **Note on Upstash:** the `UPSTASH_*` backup mirrors a **slim** copy of `db.json` to Upstash — full league/standings state minus the regenerable per-game `daily_batting`/`daily_pitching` rows (the multi-MB bulk), which keeps the payload under Upstash's ~1 MB request-size limit (`slimForBackup` in `server.js`). The server writes a live `wmmc_db` key plus rolling dated `wmmc_db_bak_<YYYY-MM-DD>` snapshots (~14-day TTL); restore them in-app via `GET /api/admin/db-backups` and `POST /api/admin/db-restore`. The **persistent disk remains the source of truth** — Upstash is disaster recovery only. Because the backup is slim, a restore brings back standings immediately but needs an MLB backfill (`POST /api/mlb/backfill`) to repopulate per-game daily detail. If the slimmed payload still exceeds the limit (`[Upstash] … exceeds the … limit` in the logs), trim further before relying on it. Before enabling `UPSTASH_*` in production, verify a real prod-sized `db.json` serializes under the limit.
