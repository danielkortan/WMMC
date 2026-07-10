// Swap-chain roster ordering — orders a roster table so a swapped-in player sits directly
// beneath the player he replaced (e.g. Logan Webb → Kyle Harrison), making a drop/add easy to
// trace. Each chain sorts by its best scorer so a strong swap-in still floats near the top,
// carrying its predecessor with it. Every roster listing (scoreboard detail panel, My Roster
// weekly tables, commissioner roster editor) uses this so swaps read the same everywhere.
//
// Pure: `names` is the players to order, `scoreByPlayer` maps name → points (the tiebreak /
// sort key), `swaps` is the season's raw swap log (filtered internally to this manager's
// approved 1-for-1 swaps between listed players), and `managerForEmail` optionally resolves a
// swap's `email` to a manager name for legacy records that lack a `manager` field.
export function orderWithSwapChains(names, scoreByPlayer, swaps, managerName, managerForEmail) {
  const nameSet = new Set(names);
  const chainSwaps = (swaps || [])
    .filter((s) => {
      if (!s.player_out || !s.player_in) return false; // only true 1-for-1 swaps can pair
      if (s.status && s.status !== 'approved') return false; // skip pending/denied
      const swapMgr = s.manager || (s.email && managerForEmail ? managerForEmail(s.email) : null);
      return swapMgr === managerName && nameSet.has(s.player_out) && nameSet.has(s.player_in);
    })
    .slice()
    .sort((a, b) => (a.swap_date || a.timestamp || '').localeCompare(b.swap_date || b.timestamp || ''));
  const childrenByParent = {};
  const isSwapIn = new Set();
  chainSwaps.forEach((s) => {
    (childrenByParent[s.player_out] = childrenByParent[s.player_out] || []).push(s.player_in);
    isSwapIn.add(s.player_in);
  });
  // `seen` guards against swap cycles (e.g. a manager swaps out A for B, then later swaps B
  // back out for A — re-acquiring a dropped player). Without it the recursion never bottoms
  // out and throws RangeError, which aborts the whole detail render so the row won't expand.
  const chainMax = (name, seen = new Set()) => {
    if (seen.has(name)) return scoreByPlayer[name] || 0;
    seen.add(name);
    let best = scoreByPlayer[name] || 0;
    (childrenByParent[name] || []).forEach((c) => (best = Math.max(best, chainMax(c, seen))));
    return best;
  };
  const ordered = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
    (childrenByParent[name] || [])
      .slice()
      .sort((a, b) => chainMax(b) - chainMax(a))
      .forEach(visit);
  };
  names
    .filter((n) => !isSwapIn.has(n))
    .sort((a, b) => chainMax(b) - chainMax(a))
    .forEach(visit);
  names.forEach(visit); // safety net for swap cycles / leftovers
  return ordered;
}
