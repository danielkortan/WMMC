---
name: verify
description: Build/launch/drive recipe for verifying WMMC changes end-to-end in the real app (Express server + SPA) with Playwright at a mobile or desktop viewport.
---

# Verifying WMMC changes in the running app

## Launch

- `npm install` (fast, usually a no-op), then `PORT=3456 node server.js` in the
  background. No build step — Express serves `index.html`/`app.js`/`js/`
  directly. No watch mode; restart after backend edits.
- Fresh clone has no `db.json`; the server seeds managers from
  `managers_seed.json` with zero seasons — the scoreboard renders empty.
  Fabricate a gitignored `db.json` for realistic state (see below).
- **Gotcha:** booting the server against a scratch `db.json` may rewrite
  `managers_seed.json` (password-stripped mirror). After any run with fake
  data: `git status` and `git checkout -- managers_seed.json` if dirty.
  Delete the scratch `db.json` when done.

## Fabricating season state (db.json)

Minimum for a scoreboard with real totals, keyed under
`seasons["<year>"]` with `status: "active"`:

- `schedule_dates`: 16 `{start, end}` entries parallel to `SEASON_SCHEDULE`
  (PP1 w1–5, PP2 w1–5, QF w1–2, SF w1–2, Finals w1–2). The banner period and
  the playoff-odds window derive from where _today_ falls (odds window =
  indices 8–9, PP2 Weeks 4–5, evaluated in America/New_York).
- Per manager: `rosters[name]["PP1|Week 1"] = {batters:[...], pitchers:[...]}`
  plus matching `roster_dates[name]["PP1|Week 1"][player] = {add_date}` —
  rows only count if the player is in the eligibility set.
- `weekly_batting` / `weekly_pitching` rows:
  `{manager, round, week, batter|pitcher, weekly_score}`.
- Playoff % pills need `playoff_odds` `{date, sims, history: [], managers:
{name: {pct, locked, pool_win_pct, wildcard_pct, points_back_pool,
points_back_cut, proj_mean, games_remaining, schedule_factor}}}`.
- Managers need a `pool` ("1"/"2"/"3") or they're excluded from every table.

## Login

The SPA is fully login-gated (empty `#scoreboard-content` until signed in).
Default password for any seeded manager is `Welcome2Hell`
(`LOGIN_PASSWORD` in server.js). Fill `#login-email` / `#login-password`,
click `#login-submit-btn`, then wait for
`#scoreboard-content .sb-manager-row`.

## Driving

Playwright is NOT a project dep — install `playwright-core` in the session
scratchpad (never in the repo) and launch with
`executablePath: '/opt/pw-browsers/chromium'`. Mobile = 390×844 (or 412×915),
`isMobile: true`; mobile.css transforms need `js/mobile.js`'s
MutationObserver, which runs automatically — give renders ~1s.
CDN loads (Chart.js, Google Sign-In) fail through the proxy — harmless for
scoreboard/roster views; don't chase those console errors. Don't pass a
`proxy` option to `chromium.launch` — the default env reaches localhost fine.

## Worth probing

- Mobile scoreboard rows are flex cards driven by cell classes/position in
  `mobile.css` (`.mob-sbrow`) — check both the odds-window-live and
  odds-absent states, expanded manager detail rows, PP1/PP2 pool tables, and
  a ~1280px desktop viewport (must keep all table columns).
