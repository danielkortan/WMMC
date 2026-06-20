# Commissioner roster add/drop — granular endpoints design plan

Status: **proposal for review** (no code changes in this doc). Tracks the last high-risk slice of
the granular-endpoints migration (#275): _Commissioner roster add/drop → targeted op_.

> This is the single most invariant-critical change in the migration. It is written design-first,
> on purpose, so the approach is reviewed before any code lands.

## 0. The invariant this must protect (non-negotiable)

From `CLAUDE.md` — the core scoring invariant:

- **Source of truth for "who is rostered, when" = `roster_dates` (add/drop windows) + approved
  `swaps`, scoped to the period.** Players enter a roster only via a submission or a swap, each
  stamped with a **date + period**.
- **`sd.rosters` (per-week arrays), the `manager` field on stat rows, and weekly rollups are
  DERIVED CACHES** — rebuild them from the date windows; never treat them as authoritative.
- **Any change touching roster windows, swaps, or scoring must be vetted with a before/after
  per-manager totals comparison.**

The design below leans _into_ this: the new endpoints write **only** the authoritative fields
(`roster_dates` windows + the `swaps` record/status) and let the **server** rebuild the derived
caches — which is strictly more correct than today's client, which mutates the cache by hand.

## 1. Current state (what rides the whole-season POST today)

Commissioner roster mutations happen client-side, then persist via the clobber-prone
`POST /api/seasons/:year` (`saveSeason`). The relevant flows in `app.js`:

| Flow                  | Function                    | What it mutates before `saveSeason`                                                                                                 |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Approve a swap        | `approveSwap` (≈8914)       | `sd.rosters` arrays (out→in across weeks), `sd.roster_dates` (drop_date/add_date), `swap.status='approved'`, `assignUnclaimedStats` |
| Deny a swap           | `denySwap` (≈9004)          | `swap.status='denied'` only — **no roster math**                                                                                    |
| Edit a swap           | `saveSwapEdit` (≈9094)      | swap fields (players/dates/reason); windows re-derived on next render                                                               |
| Edit swap reason      | `saveSwapLogReason` (≈9541) | `swap.reason` only                                                                                                                  |
| Manual add/drop dates | already atomic              | `POST/DELETE /api/seasons/:year/player-dates` ✅ (writes `roster_dates` directly)                                                   |

So "commissioner roster add/drop" really means **the swap lifecycle** (approve / deny / edit). The
raw `roster_dates` editor is already a granular endpoint; pools and schedule are done.

## 2. Building blocks that already exist server-side

- `rebuildRosterArraysFromDates(sd)` (server `server.js:3036`) — rebuilds `sd.rosters` per-week
  arrays from `roster_dates`, **period-scoped** (mirrors `managerWeekSubtotal`). This is the heal
  that makes `rosters` a pure derived cache.
- `rebuildWeeklyFromDaily(sd, round, week)` (`server.js:2315`) — recomputes weekly rollups/scores
  from daily rows for a week (handles stat (re)attribution the way `assignUnclaimedStats` does
  client-side).
- `assessSeasonWriteIntegrity(existingSd, candidateSd)` — the destructive-save guard (≥40-pt total
  crater, roster shrink, vanished managers). **Reuse it to vet every roster op.**
- `captureScoreSnapshot(sd, todayET).totals` — per-manager totals for the before/after diff.
- `computeSeasonRev(sd)` — concurrency token echoed by every atomic endpoint.

## 3. Proposed endpoints

All commissioner-only, all return `{ ok, _rev, totals_delta }`, all run the **before/after totals
vet** and refuse a write the integrity guard flags as destructive (`409`, Slack-alerted) unless an
explicit `force: true` is passed (commissioner override for a legitimate large correction).

### 3a. `POST /api/seasons/:year/swaps/:id/deny` — LOWEST RISK, ship first

- Find the swap by id; require `status === 'pending'`.
- Set `status = 'denied'`, stamp `reviewed_at`. **No roster/date/stat mutation.**
- `rebuildRosterArraysFromDates` not needed (nothing changed in windows), but run the totals vet
  anyway as a no-op assertion (delta must be ~0).
- Audit entry `swap_denied`. Return `_rev`.
- Client: `denySwap` calls this instead of mutating + `saveSeason`.

This proves the pattern end-to-end with effectively zero scoring risk.

### 3b. `PUT /api/seasons/:year/swaps/:id` — edit a swap (medium risk)

- Patch allowed fields (`player_in`, `player_out`, `reason`, `week_key`, `add_date`, `drop_date`).
- If the swap is already `approved`, re-derive its `roster_dates` windows from the edited fields,
  then `rebuildRosterArraysFromDates` + `rebuildWeeklyFromDaily` for affected weeks.
- Totals vet + integrity guard. Audit `swap_edited`.
- Client: `saveSwapEdit` / `saveSwapLogReason` call this.

### 3c. `POST /api/seasons/:year/swaps/:id/approve` — HIGHEST RISK, ship last

- Body: `{ add_date, drop_date, force? }`. Require `status === 'pending'`.
- Server performs the whole op atomically (replacing the client logic in `approveSwap`):
  1. Resolve affected week(s): `swap.week_key` if set, else all weeks where `player_out` is rostered.
  2. Write `roster_dates[mgr][wk]`: `player_out.drop_date = drop_date`, `player_in.add_date = add_date`.
  3. `swap.status = 'approved'`, stamp `reviewed_at`.
  4. `rebuildRosterArraysFromDates(sd)` — heal the per-week `rosters` arrays from the new windows.
  5. `rebuildWeeklyFromDaily(sd, round, week)` for affected weeks — re-attribute stats (server-side
     equivalent of `assignUnclaimedStats`).
  6. **Before/after totals vet**; if `assessSeasonWriteIntegrity` flags destructive and `!force`,
     **roll back in memory and 409** (no write), Slack-alert. Otherwise `writeDB`.
- Return `_rev` + `totals_delta` so the client renders the standings change without a full reload.
- Client: `approveSwap` calls this; the manual `sd.rosters`/`roster_dates` mutation is **deleted**
  (server owns it now).

## 4. Migration & safety

- **The whole-season `POST` stays as a fallback** during migration (an old tab still works), exactly
  as we did for schedule. The per-field save guards remain as defense-in-depth.
- **Sequencing (one PR each):** 3a deny → 3b edit → 3c approve. Each PR ships with the totals vet and
  a manual before/after check on a copy of prod data (per `CLAUDE.md` / `SAVE_HARDENING_PLAN.md` §7).
- **No new dependencies. No test for `server.js`** (repo convention) — but the period-scoping +
  carry-forward rules these endpoints depend on are already covered by `js/eligibility.js` unit
  tests; we extend those fixtures if the rules move.

## 5. Risks & mitigations

- **Server/client rebuild divergence.** Mitigation: the server `rebuildRosterArraysFromDates` is
  already the canonical heal used after the bulk save; we are routing through it, not reimplementing.
- **Stat reattribution gap.** `assignUnclaimedStats` (client) vs `rebuildWeeklyFromDaily` (server) —
  **OPEN QUESTION (see §6).** Must confirm the server path fully reattributes an incoming player's
  unclaimed daily rows before 3c ships.
- **A legitimate large correction trips the integrity guard.** Mitigation: explicit `force: true`
  commissioner override, audit-logged.
- **Rollback:** each endpoint is independent and additive; reverting a PR restores the client's
  `saveSeason` path. The new restore tooling (#318) backs the whole thing.

## 6. Open questions for the reviewer

1. **Stat reattribution:** is `rebuildWeeklyFromDaily(sd, round, week)` a complete server-side
   replacement for the client's `assignUnclaimedStats` on approve, or do we need a dedicated
   reattribution step? (Blocks 3c only.)
2. **Approve scope when `week_key` is empty:** keep today's "all weeks where `player_out` appears"
   behavior, or require the commissioner to pick a week? (Today it fans out across weeks.)
3. **`force` override:** acceptable to let a commissioner bypass the destructive-save guard on
   approve with an explicit flag, or should a flagged approve always hard-fail and require a manual
   `roster_dates` fix instead?
4. **Scope check:** ship all three (deny/edit/approve), or stop after deny+edit and leave approve on
   the whole-season path until there's appetite for the highest-risk piece?
