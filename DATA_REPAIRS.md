# One-time data repairs

This file tracks the **one-time, season-specific data repairs** baked into `server.js`
(and mirrored in `app.js`). They exist only to fix historical data for the active season.
Each is **gated behind a one-time `db` flag** so it self-disables after a single successful
run — it does not re-scan on every boot. Once the season they target is fully historical and
the data is confirmed correct, the repair function, its call site, and the hardcoded data can
be **deleted** (the flag in `db.json` can stay; it's harmless).

| Repair function                  | Gate flag                         | What it does                                                                                                                                                          | Hardcoded for                   |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `purgeCarriedForwardDropRecords` | `carried_forward_drop_purge_done` | Purges stat records written for players carried forward into a week after being dropped earlier.                                                                      | Not season-specific (logic fix) |
| `applyMLBApiTakeover`            | `mlb_api_takeover_v1`             | One-time migration from the Google Sheets import model to the MLB Stats API as the source of truth (strips `source: 'gsheets'` rows, disables the gsheets auto-sync). | Migration                       |

## Retired (function deleted; the `db.json` flag is left in place)

Kept here so a recurrence starts from "this was already fixed once" rather than a fresh
investigation. Each was a gated one-shot whose effects are already persisted in `db.json`,
so deleting it was a no-op at runtime.

| Repair function                 | Gate flag                          | Retired in                                                                            |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `repairMissingSwapRecords`      | `swap_records_repair_done`         | #252 (Phase 3b) — replaced by `POST .../initial-submission`                           |
| `repairMissingRosterChains`     | `roster_chains_repair_done`        | #252 (Phase 3b) — replaced by `POST .../initial-submission`                           |
| `repairBentivegnaPitcherRoster` | —                                  | #252 (Phase 3b)                                                                       |
| `purgeBoundaryAutoAdvance`      | `boundary_auto_advance_purge_done` | #423 — the damage it repaired is now structurally prevented by `isPeriodBoundaryWeek` |
| `purgeGhostHerreraFromJoey`     | `ghost_herrera_purge_done`         | #423 — hardcoded to one manager and one player; settled total verified before removal |

## Not gated (intentionally every-boot)

- **`repairCarryForwardRosters`** — gated by a _version_ (`roster_repair_version` vs `ROSTER_REPAIR_VERSION`), not a one-time flag; bumping the constant forces a full recompute. Fills empty/forward weeks every run by design.
- **`backfillWmmcQS`** — idempotent QS (quality-start) re-derivation kept as an every-boot correctness safeguard; converges on the same values, so re-running is cheap and safe.
- **`repairGhostInitialRosterPlayers`** — runs before each sync with fast early-exits; not a one-time migration.

## Removal checklist (per repair, once its season is historical)

The operative rule, learned the hard way in #423: **delete hardcoded, incident-specific
one-shots; keep generic repairs and structural migrations.** Check the "Not gated" list above
before proposing to retire anything — `repairCarryForwardRosters` in particular looks like a
large one-shot and is not one.

1. Delete the function from `server.js` (and its mirror in `app.js`, if any).
2. Delete the startup call site (and any client-side call).
3. Leave the `*_repair_done` flag in `db.json` as-is.
4. Move its row to the **Retired** table above — don't just delete the row.
