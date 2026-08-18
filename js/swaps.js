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
// - Playoffs (QF, SF, Finals): one of EACH type per round — one Free, one
//   Drop, and one Trade — plus unlimited IL swaps.
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

  // Playoffs (QF, SF, Finals): IL swaps unlimited; one each of Free, Drop, and Trade per round
  if (round === 'QF' || round === 'SF' || round === 'Finals') {
    if (reason === 'IL Swap') return null;
    if (PLAYOFF_LIMITED_REASONS.includes(reason)) {
      const usedSwap = managerSwaps.find((s) => s.reason === reason);
      if (usedSwap) {
        const roundLabel = round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : 'the Finals';
        const swapLabel = reason === FREE_SWAP_REASON ? 'Free Swap' : reason;
        return `You have already used your ${swapLabel} for ${roundLabel} (on ${usedSwap.swap_date || 'an earlier date'}). You may still use your other playoff swaps or an IL swap.`;
      }
    }
    return null;
  }

  return null;
}

// Round labels for the effective-window message below. Spelled out locally, the same way
// checkSwapLimit spells out its playoff labels, so the mirrored block stays self-contained
// (server.js has its own ROUND_LABELS, keyed without the articles this needs).
const ROUND_WINDOW_LABELS = {
  PP1: 'Pool Play 1',
  PP2: 'Pool Play 2',
  QF: 'the Quarterfinals',
  SF: 'the Semifinals',
  Finals: 'the Finals',
};

// A swap is charged to the round it was submitted in and may only move that round's roster. When
// the computed add date falls past the round's last day, the swap cannot do either half of its
// job: drop_date is inclusive, so the outgoing player still scores the whole round, and the
// incoming player's window never opens inside it. The add date then lands in the NEXT period,
// where the date-windowed eligibility scan honors it by date and quietly puts the player on a
// roster that was never submitted — crossing a period boundary the league's rules do not allow.
//
// Both failure modes come from the same date, so refuse the swap at submission instead of
// recording one that cannot do what it says. This is the AUTO path's problem specifically: an
// explicitly scheduled date is already bounded at submission ("no later than the end of the
// current round"), but the game-started rule can roll the add to tomorrow with nobody choosing
// it — and on a round's final day, tomorrow belongs to the next period.
//
// `addDate` and `roundEnd` are ISO 'YYYY-MM-DD' (lexicographic compare). Returns null when the
// swap can still take effect this round, or a user-facing error string when it cannot.
export function checkSwapEffectiveWindow(addDate, roundEnd, round, playerIn) {
  if (!addDate || !roundEnd || addDate <= roundEnd) return null;
  const label = ROUND_WINDOW_LABELS[round] || round;
  const who = playerIn || 'the incoming player';
  return (
    `A game has already started today, so this swap cannot take effect until ${addDate} — ` +
    `and ${label} ends ${roundEnd}. It would score nothing this round, and ${who} would instead be ` +
    `added inside the next period, landing on a roster you never submitted. ` +
    `The swap was not recorded and none of your swaps have been used — pick ${who} in your next ` +
    `roster submission instead.`
  );
}
