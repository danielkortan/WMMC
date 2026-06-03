# One-time data repairs

This file tracks the **one-time, season-specific data repairs** baked into `server.js`
(and mirrored in `app.js`). They exist only to fix historical data for the active season.
Each is **gated behind a one-time `db` flag** so it self-disables after a single successful
run — it does not re-scan on every boot. Once the season they target is fully historical and
the data is confirmed correct, the repair function, its call site, and the hardcoded data can
be **deleted** (the flag in `db.json` can stay; it's harmless).

| Repair function | Gate flag | What it does | Hardcoded for |
| --- | --- | --- | --- |
| `repairMissingSwapRecords` | `swap_records_repair_done` | Restores specific approved swaps confirmed via Slack but missing from the log, and removes one known erroneous duplicate. | 2026 season (Daniel Kortan, Austin Johnson, Chris Bentivegna swaps) |
| `repairMissingRosterChains` | `roster_chains_repair_done` | Restores two initial-submission roster slots and their full swap chains. | 2026 season (Austin Johnson: Skubal→Alcantara→Baz; Anton Capria: Carpenter→Devers) |
| `purgeCarriedForwardDropRecords` | `carried_forward_drop_purge_done` | Purges stat records written for players carried forward into a week after being dropped earlier. | Not season-specific (logic fix) |
| `applyMLBApiTakeover` | `mlb_api_takeover_v1` | One-time migration from the Google Sheets import model to the MLB Stats API as the source of truth (strips `source: 'gsheets'` rows, disables the gsheets auto-sync). | Migration |

## Not gated (intentionally every-boot)

- **`repairCarryForwardRosters`** — gated by a *version* (`roster_repair_version` vs `ROSTER_REPAIR_VERSION`), not a one-time flag; bumping the constant forces a full recompute. Fills empty/forward weeks every run by design.
- **`backfillWmmcQS`** — idempotent QS (quality-start) re-derivation kept as an every-boot correctness safeguard; converges on the same values, so re-running is cheap and safe.
- **`repairGhostInitialRosterPlayers`** — runs before each sync with fast early-exits; not a one-time migration.

## Removal checklist (per repair, once its season is historical)

1. Delete the function from `server.js` (and its mirror in `app.js`, if any).
2. Delete the startup call site (and any client-side call).
3. Leave the `*_repair_done` flag in `db.json` as-is.
4. Update this file.
