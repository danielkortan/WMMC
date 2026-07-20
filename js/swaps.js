// ============================================================
// WMMC — Swap eligibility rules
// ============================================================
// Canonical copy of the swap-limit rules, shared by the swap form (via
// js/index.js -> window) and mirrored in server.js (the server enforces the
// same rules at submission time and cannot import this ESM module). Like
// SCORING/SEASON_SCHEDULE and detectScoreSwings, the two copies must stay
// identical — every edit goes in both files.
//
// League rules:
// - Pool Play (PP1, PP2): one Free Swap per PP round; unlimited IL, Drop,
//   and Trade swaps.
// - Playoffs (QF, SF, Finals): one swap TOTAL per round across Free, Drop,
//   and Trade; unlimited IL swaps.
// Only pending and approved swaps consume a slot — denied and undone swaps
// refund it. Commissioner adds/drops carry no `round` field and are excluded.

export const FREE_SWAP_REASON = 'Free Swap (one per round)';
export const PLAYOFF_LIMITED_REASONS = [FREE_SWAP_REASON, 'Drop Swap', 'Trade Swap'];

// Check swap limits for a manager submitting a swap request in a round.
// `swaps` is the season's swap list, `round` the schedule round (PP1, PP2,
// QF, SF, Finals). Returns null if OK, or a user-facing error string if the
// swap must be blocked.
export function checkSwapLimit(swaps, managerName, reason, round) {
  // Only count approved or pending swaps (not denied/undone) for this manager in this round
  const managerSwaps = (swaps || []).filter(
    (s) => s.manager === managerName && (s.status === 'approved' || s.status === 'pending') && s.round === round
  );

  // Pool Play: unlimited Drop/IL/Trade, but only 1 Free Swap per PP-round
  if (round === 'PP1' || round === 'PP2') {
    if (reason === FREE_SWAP_REASON) {
      const used = managerSwaps.filter((s) => s.reason === FREE_SWAP_REASON).length;
      if (used >= 1) {
        return `You have already used your Free Swap for ${round === 'PP1' ? 'Pool Play 1' : 'Pool Play 2'}. You may still use Drop, IL, or Trade swaps.`;
      }
    }
    return null; // Drop/IL/Trade unlimited during pool play
  }

  // Playoffs (QF, SF, Finals): IL swaps unlimited; Free/Drop/Trade share ONE slot per round
  if (round === 'QF' || round === 'SF' || round === 'Finals') {
    if (reason === 'IL Swap') return null;
    const usedSwap = managerSwaps.find((s) => PLAYOFF_LIMITED_REASONS.includes(s.reason));
    if (usedSwap) {
      const roundLabel = round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : 'the Finals';
      return `You have already used your one Free/Drop/Trade swap for ${roundLabel} (${usedSwap.reason} on ${usedSwap.swap_date || 'an earlier date'}). Only IL swaps remain available this round.`;
    }
    return null;
  }

  return null;
}
