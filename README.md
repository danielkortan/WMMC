# The Whit Merrifield Memorial Cup (WMMC)

A full-stack fantasy baseball league management application with multi-season support, Google Sheets integration, and a comprehensive playoff bracket system.

## Features

- **Multi-Season Management** — Create, manage, and archive multiple seasons
- **Scoring Engine** — Configurable batting and pitching point rubrics
- **Roster Management** — Per-week rosters with player swap approval workflow
- **Google Sheets Sync** — Automated daily stat imports from Google Sheets
- **Playoff Bracket** — Pool play seeding, quarterfinals, semifinals, and finals
- **Trends & Analytics** — Season-long scoring charts per manager and player
- **Hall of Fame** — All-time records across all seasons
- **Commissioner Controls** — Full admin panel for managing the league

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla JavaScript (ES modules)
- **Database:** JSON file-based (`db.json`)
- **Charts:** Chart.js
- **Auth:** Email/password + optional Google Sign-In

## Getting Started

### Prerequisites

- Node.js 18+

### Installation

```bash
git clone <repo-url>
cd WMMC
npm install
```

### Configuration

Create a `.env` file in the project root (optional):

```env
PORT=3000
LOGIN_PASSWORD=your-secure-password
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `LOGIN_PASSWORD` | `123` | Global fallback login password |

### Running

```bash
npm start
```

Open `http://localhost:3000` in your browser.

### Development

```bash
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix lint issues
npm run format        # Format with Prettier
npm run format:check  # Check formatting
npm test              # Run tests
```

## Scoring Rubric

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

1. **Pool Play 1** — 5 weeks
2. **Pool Play 2** — 5 weeks
3. *All-Star Break*
4. **Quarterfinals** — 2 weeks
5. **Semifinals** — 2 weeks
6. **Finals / 3rd Place** — 2 weeks

## API Reference

### Seasons

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/seasons` | Get all seasons |
| `POST` | `/api/seasons` | Replace all seasons |
| `POST` | `/api/seasons/:year` | Save a single season |

### Managers

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/managers` | Get all managers |
| `POST` | `/api/managers` | Save managers list |

### Google Sheets

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/google-sheets/config` | Get sync configuration (API key masked) |
| `POST` | `/api/google-sheets/config` | Save sync configuration |
| `POST` | `/api/google-sheets/sync` | Trigger manual sync |
| `GET` | `/api/google-sheets/sync-status` | Get last sync status |

### Online Users

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/heartbeat` | Send heartbeat (body: `{ email, name }`) |
| `GET` | `/api/online-users` | Get currently online users |

### Audit Log

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/audit-log` | Get recent audit log entries (query: `?limit=50`) |

## Google Sheets Setup

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Sheets API**
3. Create an API key under **APIs & Services → Credentials**
4. In your spreadsheet, create tabs named `Week 1 Batting`, `Week 1 Pitching`, `Week 2 Batting`, etc.
5. Enter the spreadsheet URL and API key in the Commissioner panel

## Project Structure

```
WMMC/
├── server.js              # Express backend
├── index.html             # Single-page app shell
├── js/                    # Frontend modules
│   ├── app.js             # Main entry point & initialization
│   ├── state.js           # Centralized state management
│   ├── api.js             # Server API calls
│   ├── scoring.js         # Scoring calculations
│   ├── roster.js          # Roster management
│   ├── bracket.js         # Playoff bracket logic
│   ├── scoreboard.js      # Scoreboard rendering
│   ├── weekly.js          # Weekly scores view
│   ├── trends.js          # Trends & analytics charts
│   ├── commissioner.js    # Commissioner panel
│   ├── gsheets.js         # Google Sheets integration
│   ├── halloffame.js      # Hall of Fame
│   ├── leagueinfo.js      # League info (schedule, rules)
│   ├── auth.js            # Authentication
│   ├── utils.js           # Shared utilities
│   └── csv.js             # CSV parsing helpers
├── css/                   # Stylesheets
│   ├── main.css           # Imports all partials
│   ├── base.css           # Reset, variables, typography
│   ├── layout.css         # Header, nav, footer, cards
│   ├── components.css     # Buttons, forms, tables, badges
│   ├── scoreboard.css     # Scoreboard-specific styles
│   ├── bracket.css        # Bracket/playoff styles
│   ├── roster.css         # Roster page styles
│   ├── commissioner.css   # Commissioner panel styles
│   ├── trends.css         # Trends/analytics styles
│   ├── login.css          # Login screen styles
│   └── responsive.css     # Media queries
├── tests/                 # Automated tests
│   └── scoring.test.js    # Scoring calculation tests
├── .eslintrc.json         # ESLint configuration
├── .prettierrc.json       # Prettier configuration
├── data.json              # 2025 historical season data
├── db.json                # Runtime database (gitignored)
└── package.json           # Dependencies & scripts
```
