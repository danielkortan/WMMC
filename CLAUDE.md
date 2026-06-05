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
- `styles.css` — All styles (monolithic)
- `js/` — Extracted frontend modules (`scoring.js`, `csv.js`, `utils.js`, `index.js`)
- `tests/` — Unit tests for `js/` modules only
- `db.json` — Runtime database (gitignored); written by server on every mutation
- `managers_seed.json` — Committed manager identities (no passwords); seeds `db.json` on fresh deploy
- `data.json` — Historical seed data (read-only)
- `render.yaml` — Render.com deploy config
- `.githooks/` — Git hooks (pre-push stamps `version.json`)

## Permanent project facts

These are always true. Apply to every session. If a task conflicts with one, flag it before proceeding.

- `SCORING` and `SEASON_SCHEDULE` are hardcoded in **both** `server.js` and `app.js` and must be kept in sync — every edit goes in both files.
- Never commit `db.json` — it is gitignored and contains passwords.
- `managers_seed.json` stores manager identities but never passwords — the server strips passwords before writing it.
- The frontend has no build step — `index.html` loads files directly; there is nothing to compile or bundle.
- Once a function is moved to `js/`, delete its copy from `app.js` — do not let both coexist.

## Git workflow

- **Always open a pull request for every change — never push to `main` directly.** This is the standard process for this repo: develop on a feature branch, push it, and open a PR so changes are reviewed and CI runs before they reach production. (`render.yaml` auto-deploys `main` on merge, so a merged PR _is_ a production deploy.)
- Open the PR as soon as the branch is pushed and the work is ready for review — don't wait to be asked. After opening one, offer to watch it for CI failures and review comments.
- Keep PRs focused: one logical change per PR, with a clear title and a body summarizing what changed and why.
- Do not merge your own PR unless explicitly told to — opening it is the deliverable; merging is the maintainer's call.

## Conventions and patterns

- **Error handling:** Route handlers return `{ error: '...' }` JSON with an appropriate HTTP status code. Never swallow errors silently.
- **Logging:** Plain `console.log` / `console.error` — no abstraction layer.
- **Naming:** camelCase for variables and functions.
- **Imports:** CommonJS `require()` in `server.js` and `app.js`; ES module `export`/`import` in `js/` modules. Do not mix the two styles within a file.
- **Testing philosophy:** Unit-test pure logic in `js/`. There are no e2e tests. Do not write tests for `server.js` or `app.js` directly.

## Gotchas — things that look wrong but aren't

- `SCORING` and `SEASON_SCHEDULE` appear in both `server.js` and `app.js`. This is intentional — the server needs them for score recomputation and Slack posts; the client needs them for live scoring. They must stay identical.
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
- Don't edit `SCORING` or `SEASON_SCHEDULE` in only one file — both `server.js` and `app.js` must be updated together.
- Don't skip the pre-push hook (`--no-verify`).
- Don't push directly to `main` or merge without a PR — every change goes through a pull request.

## Memory files

- `MEMORY.md` — decisions log. Read at session start if it exists. Append on meaningful decisions and at session end.
- `ERRORS.md` — what didn't work and what did. Check before proposing approaches to similar problems.

(These files do not exist yet — create them when first needed.)
