# WMMC — Decisions Log

## Google Sign-In (added 2026-06-04)

"Sign in with Google" on the login page, alongside email/password.

- **Gated by `GOOGLE_CLIENT_ID` env var** (OAuth 2.0 Web client ID, set per Render service). Unset → button hidden, email/password unaffected. Client ID is served to the browser via `GET /api/auth/config`; it is NOT a secret.
- **Server-side verification, no new dependency:** `verifyGoogleIdToken()` in `server.js` checks the ID token's RS256 signature against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached per Cache-Control) using built-in `crypto`, then validates iss/aud/exp/email_verified. The earlier scaffolding decoded the JWT client-side without verifying — that was insecure and is gone.
- **Auth model preserved:** `POST /api/auth/google` issues a per-manager `authToken` (random hex stored on the manager record). `loadManagerFromHeaders` accepts it in the `X-User-Password` header just like a password, so Google users get full access (swaps, commissioner) with no session store. `authToken` is a credential: stripped from `GET /api/managers` and the committed seed, preserved across manager saves like `password`.
- **Email mapping:** managers have a `googleEmail` field (editable in the admin panel, shown as a "Google Email" column). The Google account's verified email is matched against `googleEmail || email`. A one-shot startup backfill defaults `googleEmail = email` for every manager. Use it when a manager's Google address differs from their league email.
- **Origins:** every browser origin must be listed in the Google Cloud OAuth client's Authorized JavaScript origins (exact scheme+host, https except localhost). Prod authorized: `https://wmmc.live` (+ `www` if it resolves). Staging would need its own client ID + `https://wmmc-staging.onrender.com` authorized — not set up, so the staging button stays hidden.

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

## Git identity — run at session start (established 2026-06-04)

The pre-push hook stamps `version.json` as a new commit. If `user.email` isn't
`noreply@anthropic.com` at that moment the commit is unverified. Always run this
before the first push in any session:

```
git config user.email noreply@anthropic.com && git config user.name Claude
```

## Mobile CSS patterns (established 2026-06-04)

- Manager name font: `clamp(1rem, 4.5vw, 2.2rem)` in live section (5 columns); `2.2rem` fixed in scoreboard (3 columns — more room).
- Header h1 (WMMC abbreviation): `clamp(1rem, 5vw, 1.6rem)`; use `.header-title-long` / `.header-title-short` spans with `!important` on `display` to guarantee the abbreviation shows on mobile.
- All three header elements (h1, season-selector, user-bar) use `flex: 0 1 auto; min-width: 0` so they share space proportionally without overflowing.
- Season `<select>` on mobile: `background: transparent` so it doesn't render as a big white/dark box against the header gradient.
- Live title row: `flex-wrap: wrap` so long pool-play week names don't overflow — date nav drops to a second line gracefully.
- Font overrides that compete with `styles.css` need `!important` (e.g., `#live-week-title`, `.live-game-line`).
- Today's Games game rows: `1.9rem` (2× the 0.95rem base) with `!important`.
