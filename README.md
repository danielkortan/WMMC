# The Whit Merrifield Memorial Cup (WMMC)

A full-stack fantasy baseball league management application with multi-season support, Google Sheets stat sync, and a complete playoff bracket system.

## Features

- **Multi-Season Management** — Create, manage, and archive multiple seasons
- **Configurable Scoring** — Per-stat batting and pitching point rubrics (currently hardcoded; see [Scoring Rubric](#scoring-rubric))
- **Roster Management** — Per-week rosters with a manager-initiated swap workflow that the commissioner approves
- **Google Sheets Sync** — Pull weekly stats from a linked spreadsheet on a daily schedule
- **Playoff Bracket** — Pool play seeding feeds quarterfinals, semifinals, finals, and a 3rd-place game
- **Trends & Analytics** — Season-long Chart.js visualizations per manager and player
- **Hall of Fame** — All-time records across past seasons
- **Commissioner Panel** — Roster overrides, manager management, stat uploads, season setup, swap approvals, audit log
- **Slack Integration** — Optional webhooks for swap notifications and a daily scoreboard post

## Tech Stack

- **Backend:** Node.js + Express, file-backed JSON store with optional Upstash Redis backup
- **Frontend:** Vanilla JS (single-file, currently being modularized — see [Project Structure](#project-structure))
- **Charts:** Chart.js (loaded from CDN)
- **Auth:** Email/password against `db.json`, with optional Google Sign-In (set `GOOGLE_CLIENT_ID` in `app.js`)

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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `LOGIN_PASSWORD` | `Welcome2Hell` | Global fallback password used when a manager has no per-account password set |
| `DB_PATH` | `./db.json` | Path to the runtime JSON database. On Render, point this at a persistent disk mount. |
| `UPSTASH_REDIS_REST_URL` | _(unset)_ | Optional. When set, `db.json` is mirrored to Upstash so it survives ephemeral redeploys. |
| `UPSTASH_REDIS_REST_TOKEN` | _(unset)_ | Auth token paired with `UPSTASH_REDIS_REST_URL`. |
| `SLACK_WEBHOOK_URL` | _(unset)_ | General notifications channel (swaps, sync errors). |
| `SLACK_SCOREBOARD_WEBHOOK_URL` | falls back to `SLACK_WEBHOOK_URL` | Channel for the daily scoreboard post. |
| `SLACK_SIGNING_SECRET` | _(unset)_ | Required if you wire up the `/api/slack/command` slash command. |

### Running

```bash
npm start
```

Open `http://localhost:3000` in your browser.

### Development

```bash
npm run lint          # Run ESLint on server.js + app.js
npm run lint:fix      # Auto-fix what ESLint can fix
npm run format        # Format the entire repo with Prettier
npm run format:check  # Verify formatting without writing
npm test              # Run tests in tests/ (no tests at present)
```

## Scoring Rubric

The rubric is hardcoded in **two places that must stay in sync**: `app.js` (`SCORING` constant) and `server.js` (`SCORING` constant). Any edit must be applied to both files.

### Batting

| Category | Points |
|---|---|
| Singles (1B) | 3 |
| Doubles (2B) | 5 |
| Triples (3B) | 8 |
| Home Runs (HR) | 10 |
| Runs (R) | 2 |
| RBIs | 2 |
| Stolen Bases (SB) | 5 |
| Walks (BB) | 2 |

### Pitching

| Category | Points |
|---|---|
| Wins (W) | 4 |
| Quality Starts (QS) | 4 |
| Complete Games (CG) | 2.5 |
| Complete Game Shutouts (CGSO) | 2.5 |
| No-Hitters (NH) | 5 |
| Innings Pitched (IP) | 2.25 |
| Hits (H) | -0.6 |
| Earned Runs (ER) | -2 |
| Walks (BB) | -0.6 |
| Strikeouts (K) | 2 |

## Season Structure

A season is 16 scoring weeks plus a midseason break.

1. **Pool Play 1** — 5 weeks (Weeks 1–5)
2. **Pool Play 2** — 5 weeks (Weeks 6–10)
3. *All-Star Break* (no scoring)
4. **Quarterfinals** — 2 weeks (Weeks 11–12)
5. **Semifinals** — 2 weeks (Weeks 13–14)
6. **Finals + 3rd-Place Game** — 2 weeks (Weeks 15–16)

The schedule is hardcoded in `app.js` (`SEASON_SCHEDULE`) and `server.js` (`SEASON_SCHEDULE`).

## API Reference

All endpoints return JSON. Endpoints that read state are unauthenticated; endpoints that mutate state perform their own per-request password/role checks.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/login` | Validate `{ email, password }`. Returns `{ ok, manager }` or 401. |
| `POST` | `/api/managers/:email/change-password` | Manager self-service password change. |

### Seasons

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/seasons` | All seasons keyed by year. |
| `POST` | `/api/seasons` | Replace the entire seasons map. |
| `POST` | `/api/seasons/:year` | Save a single season. |
| `DELETE` | `/api/seasons/:year/week-data` | Wipe a single week's uploaded stats for a season. |
| `POST` | `/api/seasons/:year/recompute-scores` | Recompute weekly scores from scratch. |

### Player Dates & Daily Stats

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/seasons/:year/player-dates` | Per-player add/drop dates. |
| `POST` | `/api/seasons/:year/player-dates` | Save player dates. |
| `DELETE` | `/api/seasons/:year/player-dates` | Clear player dates. |
| `GET` | `/api/seasons/:year/daily-stats` | Daily stat snapshots used for mid-week add/drop scoring. |
| `POST` | `/api/seasons/:year/daily-stats` | Append daily stats. |
| `DELETE` | `/api/seasons/:year/daily-stats` | Clear daily stats. |

### Managers

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/managers` | All manager records (passwords stripped). |
| `POST` | `/api/managers` | Replace the manager list. |
| `POST` | `/api/managers/:email/password` | Commissioner sets a manager's password. |
| `DELETE` | `/api/managers/:email/password` | Commissioner clears a manager's password (falls back to `LOGIN_PASSWORD`). |

### Google Sheets Sync

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/google-sheets/config` | Returns sync config; API key is masked. |
| `POST` | `/api/google-sheets/config` | Save sync config. |
| `POST` | `/api/google-sheets/sync` | Trigger a manual sync. |
| `GET` | `/api/google-sheets/sync-status` | Last sync status, errors, timestamp. |

### Slack

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/slack/scoreboard` | Manually trigger the scoreboard Slack post. |
| `POST` | `/api/slack/command` | Slash-command webhook (verified via `SLACK_SIGNING_SECRET`). |

### Misc

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/pending-count` | Count of pending swap requests across active seasons. |
| `GET` | `/api/audit-log` | Recent audit entries. Query: `?limit=50`. |
| `GET` | `/api/banner-config` | Custom banner background config. |
| `POST` | `/api/banner-config` | Save banner config. |
| `POST` | `/api/heartbeat` | Online-user heartbeat. Body: `{ email, name }`. |
| `GET` | `/api/online-users` | Currently online users. |

## Google Sheets Setup

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **Google Sheets API**.
3. Create an API key under **APIs & Services → Credentials**.
4. In your spreadsheet, create tabs named `Week 1 Batting`, `Week 1 Pitching`, `Week 2 Batting`, etc.
5. Enter the spreadsheet URL and API key in the Commissioner panel under **Stats Data → Google Sheets Auto-Sync**.

## Project Structure

```
WMMC/
├── server.js              # Express backend (routes, scoring, sheets sync, slack)
├── app.js                 # Frontend monolith — currently being modularized into js/
├── index.html             # Single-page app shell
├── styles.css             # All styles (currently monolithic; will move to css/)
├── data.json              # Historical 2025 season data (read-only seed)
├── managers_seed.json     # Committed manager identities (no passwords)
├── db.json                # Runtime database (gitignored, written by server)
├── version.json           # Build version stamp updated by .githooks/pre-push
├── render.yaml            # Render.com deployment config
├── package.json           # Dependencies & npm scripts
├── .eslintrc.json         # ESLint configuration
├── .prettierrc.json       # Prettier configuration
├── .githooks/
│   └── pre-push           # Auto-stamps version.json with today's date
├── js/                    # New modular frontend (extracted from app.js — work in progress)
└── tests/                 # Tests for js/ modules
```

> **Note on ongoing modularization:** The frontend has historically been a single `app.js` file. We're incrementally extracting pure logic (scoring, CSV parsing, utilities) into `js/` modules, with matching tests in `tests/`. Until the migration is complete, both layers co-exist: `index.html` still loads `app.js` directly, and the extracted modules are exercised through `tests/`. Do not duplicate logic between layers — once a function is in `js/`, delete its sibling in `app.js` and call into the module via `<script type="module">`.

## Deployment

The app is configured for [Render.com](https://render.com) via `render.yaml`. The disk mount at `/var/data` keeps `db.json` across deploys. Set `LOGIN_PASSWORD`, `SLACK_WEBHOOK_URL`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` as secret env vars in the Render dashboard.
