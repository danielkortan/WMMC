# Save / roster-integrity hardening — design plan

Status: **proposal for review** (no code changes in this doc).
Author: drafted after the 2026‑06‑08 `sd.rosters` wipe and a week of date-window scoring bugs.

---

## 0. The core invariant (make this law)

> **A manager's score is the sum, over each player they roster, of the points that player earns
> _only_ within that player's roster window (`add_date` → `drop_date`), within the period the
> player was rostered for that manager.**

Corollaries that every contributor must treat as non-negotiable:

- The **single source of truth** for "who is rostered, when" is **`roster_dates` + approved
  `swaps`** (date windows), scoped to the **period** (PP1/PP2/QF/SF/Finals). A new submission
  period starts fresh from its submission; players do **not** carry across a period boundary.
- **Managers** come from exactly one place: the **commissioner page (`db.managers`)**. That is the
  canonical list; every other element (scoreboards, Slack, swap form, exports) must read managers
  from it and never invent, infer, or drop them.
- **Players enter a roster only via** an initial/period **submission** or a **swap** (including a
  commissioner swap) — always stamped with a **date and a period identifier**. No other path may
  put a player on a roster.
- `sd.rosters` (per-week arrays), the `manager` field on `weekly_*`/`daily_*` stat rows, and the
  weekly rollups are all **derived caches**. They must be _rebuilt from_ the date windows, never
  treated as authoritative.
- Anything that reads or writes rosters/eligibility/scores must honor the windows and read the
  manager + roster data **completely, every time** (no partial/stale snapshots). Re-deriving a
  scored week from a sticky/aggregate field (e.g. the stat-row `manager`) is a bug.

This section should be copied into `CLAUDE.md` under "Permanent project facts" so it governs every
future change.

### Why this matters (the week's pattern)

Every scoring incident this week was a violation of the invariant:

- **Cross-manager leak / carry-forward** (06‑06): eligibility ignored add/drop windows.
- **`sd.rosters` wiped** (06‑08): attribution cache blanked by a stale save; standings survived on
  `roster_dates` but Best/Worst broke and the next compile would have zeroed the board.
- **Recovery mis-steps** (06‑08): rebuilding rosters from the sticky stat-row `manager` re-added
  dropped players; global carry-forward leaked PP1 players into PP2.

The fixes landed (#281–#285), but they were reactive. This plan addresses the **mechanism** that
keeps letting these in.

---

## 1. Root cause: the fire-and-forget full-season overwrite

`saveSeason(year, data)` (`app.js`) POSTs the client's **entire** cached season to
`POST /api/seasons/:year`:

```js
function saveSeason(year, data) {
  const seasons = getSeasons();
  seasons[year] = data;
  localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
  apiFetch('/api/seasons/' + year, { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
}
```

Problems, in order of severity:

1. **No concurrency control.** The payload is the client's `localStorage` snapshot, which may be
   stale (tab loaded before another user/sync changed the server). The save blindly overwrites.
2. **~25 call sites.** `saveSeason` is invoked from ~25 places in `app.js`, each a full-season
   overwrite. Any one of them can ship a stale snapshot.
3. **Whack-a-mole field protection.** The server defends with a hand-maintained allowlist of fields
   to preserve from the incoming payload (stats, pools, `roster_dates`, `schedule_dates`,
   submissions, swaps, and — only since 06‑08 — `rosters`). **Every new server-authoritative field
   is unprotected until someone remembers to guard it.** That is precisely how `rosters` was wiped.
4. **Invisible failure.** `.catch(() => {})` swallows errors; a rejected/blocked save is silent.

The team already started migrating off this path — submissions and swaps have dedicated atomic
endpoints, and the code comments call it "the clobber-prone full-season save." This plan finishes
that direction and adds backstops.

---

## 2. Goals / non-goals

**Goals**

- A stale browser tab can never silently clobber newer server state — for **any** field, without
  per-field maintenance.
- Any write that would destroy rosters or swing scores is **blocked and surfaced** (before/after
  self-correction), not applied.
- Changes to roster/eligibility/score logic are vetted with before/after comparisons by default.

**Non-goals**

- Rewriting the frontend off the monolith (out of scope; incremental).
- Changing the scoring math or the date-window semantics (those are correct; we're protecting them).

---

## 3. Proposed solution — defense in depth

Four server layers + one process layer. Each is independently valuable; together they make the
invariant durable.

### Layer 1 — Optimistic concurrency gate (primary fix)

**Idea:** every season carries a monotonic `rev`; the full-season save must present the `rev` it
loaded, and the server rejects it if stale.

**Data model**

- Add `sd.rev` (integer, default 0). Bump it on **every server-side write** of a season, via a
  single chokepoint helper:
  ```js
  // returns the write result; the ONLY sanctioned way to persist a season
  function commitSeason(db, year, sd, opts) {
    sd.rev = (sd.rev || 0) + 1;
    db.seasons[year] = sd;
    return writeDB(db); // existing atomic temp→fsync→rename + Upstash mirror
  }
  ```
  Retrofit the season-persisting endpoints (full save, atomic submission/swap endpoints, MLB sync,
  auto-advance, reconstruct, all `saveSeason`-backed commissioner endpoints) to go through it.

**Client contract**

- `GET /api/seasons` already returns the season; the client records `rev` per season.
- `saveSeason` includes `rev` in the body (or an `If-Match: <rev>` header).

**Server contract (full-season save only)**

- If `body.rev === sd.rev` → accept, then `commitSeason` bumps to `rev+1`.
- If `body.rev < sd.rev` → **409 Conflict**, body `{ error: 'stale', current_rev, ... }`, no write.
- If `body.rev` is **absent** (old cached `app.js`) → **reject 409** with a "reload required"
  message. Rationale below.

**Client 409 handling**

- On 409, the client re-`GET`s the season, replays the user's intended change against fresh state
  if it can, otherwise shows "Your view was out of date — reloaded; please redo that action." No
  more silent clobber. `saveSeason` must stop swallowing errors.

**Migration / rollout**

- Seed `rev = 0` for existing seasons on first read.
- The pre-push hook already stamps `version.json` + asset cache versions on every deploy, so
  browsers fetch fresh `app.js`; most tabs pick up the rev-aware client quickly. A tab left open on
  the **old** JS won't send `rev` → it is rejected (safe) rather than allowed to clobber.

**Edge cases**

- Brand-new season (no `sd.rev` yet): first save allowed, seeds `rev`.
- Two legitimate quick saves from the same fresh client: second carries the bumped `rev` from the
  first's response; if the client didn't await, it 409s and replays — acceptable.

**Why this is the big one:** it closes the entire stale-overwrite class for **all fields at once**,
so we stop adding per-field guards.

### Layer 2 — Invert the merge to "protect by default"

Today the save preserves an explicit allowlist. Flip the model:

- Classify every season field as **client-owned** (a tiny set the full-season save may write) vs
  **server-authoritative** (everything else: `rosters`, `roster_dates`, `swaps`, `schedule_dates`,
  `weekly_*`, `daily_*`, `*_team`, `*_pool`, submissions, `advanced_weeks`, `score_snapshots`,
  `rev`, …).
- The full-season save may only modify client-owned fields; server-authoritative fields are always
  taken from the server copy unless a **dedicated atomic endpoint** changed them.
- Result: a newly-added server field is protected automatically — no guard to forget.

This is the structural complement to Layer 1 (covers the transition window where an old tab lacks
`rev`).

### Layer 3 — Roster/score integrity guard (before/after, self-correcting)

Generalize the existing score-swing guard (`captureScoreSnapshot` / `evaluateScoreGuard`, PR #247)
into a **pre-commit check inside `commitSeason`** for any write touching rosters/`roster_dates`/
`swaps`:

1. **Before:** capture per-manager totals (`captureScoreSnapshot`) **and** a structural fingerprint:
   `{ managerCount, perWeekRosterSizes, rosterDatesEntryCount, swapsApprovedCount }`.
2. Apply the candidate state.
3. **After:** recompute the same.
4. **Block** (keep prior state, Slack-alert, record `last_sync_status.ok=false`) when it detects
   destruction:
   - `rosters` emptied or `managerCount` dropped;
   - a started week's roster emptied that previously had players;
   - `roster_dates`/approved-swaps counts shrink beyond a small tolerance;
   - any manager's total drops ≥ the score-guard threshold (reuse the 40‑pt rule).
     **Warn** (allow) on small/expected moves.
5. **Force path:** a `force: true` flag (commissioner) bypasses the block for legitimate big
   corrections — same model as `wmmc.forceSync()`.

This is the literal "before/after comparison with self correction" requested: a bad write
self-corrects by being rejected, and the commissioner is told why.

### Layer 4 — Extend the boot/periodic integrity audit

`auditSeasonIntegrity` already checks `schedule_dates` length, score-snapshot presence, and (since
06‑08) an empty `rosters` object. Extend it to:

- per-manager roster present & non-empty for every **started** week;
- `roster_dates` present for active managers;
- `rev` present.
  Alert via Slack on regression. Detection only (never mutates).

### Layer 5 — Scoring/eligibility test harness (process guardrail)

The pure date-window logic must be unit-tested so any change is vetted automatically:

- Move the eligibility core (or a faithful mirror) into a `js/` pure module and unit-test it under
  `tests/`, with fixtures covering: full-week roster, mid-week add, mid-week drop, swap pair,
  re-add after drop, **period boundary** (PP1→PP2: holdover excluded, kept player retained), and
  playoff rounds.
- Each fixture asserts per-manager / per-week / per-period totals — i.e. before/after expectations.
- **Policy:** any PR touching rosters/eligibility/scores must add/extend a fixture and run the
  harness. Document in `CLAUDE.md`.

---

## 4. Sequencing & risk

| Phase | Contents                                                       | Risk                                                              | Why first                                                                               |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **1** | Layer 1 (concurrency gate) + Layer 3 (integrity guard)         | Medium — touches the save chokepoint and ~20 server persist sites | Stops the bleeding for all fields and adds the before/after self-correction immediately |
| **2** | Layer 2 (protect-by-default merge) + Layer 4 (audit extension) | Low–medium                                                        | Structural backstop + visibility                                                        |
| **3** | Layer 5 (test harness) + `CLAUDE.md` invariant                 | Low                                                               | Locks the invariant in for the future                                                   |

Each phase ships as its own reviewed PR with before/after verification on a copy of `db.json`.

---

## 5. Risks & mitigations

- **Retrofit breadth (Layer 1).** Routing ~20 persist sites through `commitSeason` is the riskiest
  mechanical change. Mitigation: keep `commitSeason` a thin wrapper over today's
  `db.seasons[year]=sd; writeDB(db)`; convert call sites incrementally; the integrity guard (Layer 3) backstops any missed site.
- **Old open tabs during rollout.** They lack `rev` → rejected (safe) and Layer 2/3 catch any write
  that slips through before assets refresh.
- **False-positive blocks (Layer 3).** A legitimate large correction could trip the guard.
  Mitigation: `force: true` + Slack alert, exactly like the existing score guard, so it's a
  speed bump, not a wall.
- **Rollback.** Each phase is independently revertable; the concurrency gate can be disabled with a
  feature flag (`CONCURRENCY_GATE=off`) if it misbehaves in production.

## 6. Deploy / rollback plan

- Render auto-deploys `main`; `version.json` stamping busts asset caches so clients reload `app.js`.
- Ship Phase 1 mid-week (not before a sync window). Watch `last_sync_status` and the integrity
  Slack channel for 24–48h.
- Keep `reconstruct-rosters` as the recovery lever; the dated Upstash backups remain the escape
  hatch.

## 7. Vetting protocol for future changes (the standing rule)

Any change touching **manager lists, player lists, roster windows, swaps, or scoring** must:

1. Run the Layer‑5 harness (and add a fixture for the case being changed).
2. Include a **before/after per-manager totals diff** on a real `db.json` copy in the PR
   description, demonstrating the totals move only as intended.
3. State explicitly how it preserves the date-window invariant.

## 8. Decisions (2026‑06‑08 review)

- **Missing-`rev` policy (Phase 1b): REJECT.** A save without a `rev` token (old cached JS) gets a
  409 + "reload required". Safest — a stale tab can never clobber. The integrity guard still
  backstops during the brief window before assets refresh.
- **Integrity-guard strictness: ADD a structural limit** (shipped in Phase 1a). Beyond the 40‑pt
  total-drop block, also block when a week's roster shrinks by more than `MAX_WEEK_ROSTER_SHRINK`
  (=1) players, catching sub‑40‑pt clobbers that strip players without a matching swap.

- **Concurrency token: content-hash `rev`** (chosen over a stored counter). Computed on the fly by
  `computeSeasonRev(sd)` over `{rosters, roster_dates, swaps, schedule_dates, initial_submissions,
period_submissions}`; no counter to bump, no 20-site retrofit, and a stats-only sync can't
  false-trip it.

## 9. Implementation status

- **Phase 1a — DONE (merged #286):** destructive-save integrity guard + structural limit + invariant.
- **Phase 1b — DONE (merged #288):** content-hash `rev` gate. `GET /api/seasons` attaches `_rev`;
  `POST /api/seasons/:year` rejects a missing/stale `_rev` with 409; the client sends `_rev`,
  refreshes + reloads on 409 (one-shot guarded), records the new `_rev` on success; automatic
  render-time saves are `{ silent: true }`. The `/swaps` and `/submissions` atomic endpoints return
  the new `_rev` and the client adopts it, so a follow-up full-season save (e.g. approving a swap)
  doesn't false-trip the gate. Verified on staging.
- **Layer 4 — DONE (merged #289):** roster/manager provenance audit (boot + on-demand endpoint).

### Phase 2

- **Layer 2 (protect-by-default merge) — SKIPPED (intentional).** With the rev gate live, it is
  redundant: the gate already rejects every stale/missing-token save, closing the unguarded-field
  class for all fields. A true "server-authoritative by default" rule would also conflict with the
  legitimate full-season roster/date edits (commissioner roster editor, swap approval). Revisit only
  if the full-season save is ever fully retired in favor of atomic endpoints.
- **Bulk `POST /api/seasons` cleanup — DONE.** The unused, guard-bypassing bulk full-replace now runs
  the destructive-save integrity check per season and refuses a destructive replacement (409) unless
  `force: true`. Closes the bypass hole without removing the endpoint.
- **Layer 5 test harness — DONE.** `js/eligibility.js` isolates the date-window + period rules as
  pure functions, unit-tested in `tests/eligibility.test.js` (full-week / mid-week add / drop / swap
  pair / re-add / **PP1→PP2 period boundary** / game-date window). It is the canonical spec; the
  server/app inline copies are kept in sync with it (the server can't import ESM `js/` — same
  arrangement as SCORING / detectScoreSwings).

### Rollout note (Phase 1b)

- After a deploy, a tab still on old JS sends no `_rev` → 409 (silent on the old client). Reload the
  tab to pick up the rev-aware client; `version.json` asset-busting nudges this.
