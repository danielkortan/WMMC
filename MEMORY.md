# WMMC — Decisions Log

## Deployment workflow (established 2026-06-04)

After completing any feature branch, always:
1. **Squash-merge** the feature branch into `staging` (no confirmation needed unless there are open questions or merge conflicts)
   ```
   git checkout staging && git merge --squash <feature-branch>
   git commit -m "<summary>"
   git push origin staging
   ```
2. **Tell the user**: "Pushed to staging — check wmmc-staging.onrender.com. When ready, let me know and I'll merge to prod."
3. **Wait** for the user's go-ahead before touching `main`.
4. The user handles branch deletion themselves.

Do NOT ask whether to push to staging — just do it at the end of every session unless there is an explicit reason not to (e.g., the user said "don't push yet").

## Mobile CSS patterns (established 2026-06-04)

- Manager name font: `clamp(1rem, 4.5vw, 2.2rem)` in live section (5 columns); `2.2rem` fixed in scoreboard (3 columns — more room).
- Header h1 (WMMC abbreviation): `clamp(1rem, 5vw, 1.6rem)`; use `.header-title-long` / `.header-title-short` spans with `!important` on `display` to guarantee the abbreviation shows on mobile.
- All three header elements (h1, season-selector, user-bar) use `flex: 0 1 auto; min-width: 0` so they share space proportionally without overflowing.
- Season `<select>` on mobile: `background: transparent` so it doesn't render as a big white/dark box against the header gradient.
- Live title row: `flex-wrap: wrap` so long pool-play week names don't overflow — date nav drops to a second line gracefully.
- Font overrides that compete with `styles.css` need `!important` (e.g., `#live-week-title`, `.live-game-line`).
- Today's Games game rows: `1.9rem` (2× the 0.95rem base) with `!important`.
