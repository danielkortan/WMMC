# [PROJECT NAME]

> Per-project CLAUDE.md. Lives at the project root. Read at the start of every session.
> Personal defaults (communication style, scope rules, etc.) live in `~/.claude/CLAUDE.md` — don't duplicate them here. Only put project-specific stuff in this file.

## What this project is

[1-2 sentences. What does this thing do, and who uses it?]

[Optional: link to a longer README or spec if one exists]

## Tech stack — use these, do not suggest alternatives

Always use the tools below. If you genuinely think the wrong tool was chosen for a task, flag it once, then proceed with the stack unless I say otherwise.

- **Language:** [e.g. TypeScript 5.x]
- **Runtime:** [e.g. Node 20]
- **Frontend framework:** [e.g. Next.js 14 App Router]
- **Backend / API:** [e.g. Next.js API routes, or FastAPI, etc.]
- **Database:** [e.g. PostgreSQL via Prisma]
- **Auth:** [e.g. Clerk, NextAuth, custom]
- **Styling:** [e.g. Tailwind CSS + shadcn/ui]
- **Testing:** [e.g. Vitest + Playwright]
- **Package manager:** [e.g. pnpm — never npm or yarn]
- **Hosting / deploy:** [e.g. Vercel]

## Commands

- Install: `[pnpm install]`
- Dev server: `[pnpm dev]`
- Test (all): `[pnpm test]`
- Test (one file): `[pnpm test path/to/file]`
- Lint: `[pnpm lint]`
- Typecheck: `[pnpm typecheck]`
- Build: `[pnpm build]`
- Run before committing: `[pnpm typecheck && pnpm lint]`

## Architecture in one paragraph

[How does data flow? Where do new things go? Example: "API routes in app/api/ call services in lib/services/, which are the only place that touches the database via lib/db.ts. Components are server components by default; only mark 'use client' when you need state or events. Auth is checked at the route boundary, not inside services."]

## Where things live

- `app/` — [routes and pages]
- `components/` — [reusable UI]
- `lib/services/` — [business logic]
- `lib/db.ts` — [DB client, the only file that imports Prisma]
- [add the folders that matter for this project]

## Permanent project facts

These are always true. Apply to every session. If a task conflicts with one, flag it before proceeding.

- [e.g. "All dates are stored in UTC; conversion happens in the view layer only."]
- [e.g. "User-facing copy lives in lib/copy.ts — never hardcode strings in components."]
- [e.g. "Never call the database from a component. Always go through a service in lib/services/."]
- [e.g. "Public API responses are typed in lib/types/api.ts — update the type when changing the response."]
- [add things that are specific to this project that I'd want enforced]

## Conventions and patterns

- **Error handling:** [e.g. "Services throw typed errors from lib/errors.ts. Route handlers catch and map to HTTP responses. Never swallow errors silently."]
- **Logging:** [e.g. "Use logger from lib/log.ts. No console.log in committed code."]
- **Naming:** [e.g. "camelCase for variables, PascalCase for components and types, kebab-case for filenames."]
- **Imports:** [e.g. "Absolute imports via @/* alias. No relative imports across top-level folders."]
- **Testing philosophy:** [e.g. "Unit-test services and lib/. E2E-test critical user flows. Don't test components in isolation unless they have complex logic."]

## Gotchas — things that look wrong but aren't

- [e.g. "The build-time warning about useSearchParams is expected; it's a Next.js quirk we can't suppress."]
- [e.g. "Don't move file X to folder Y — it's imported by a generated file that the build script writes."]
- [add traps that have bitten you before]

## Do / Don't

**Do:**
- Run `pnpm typecheck` and `pnpm lint` before considering a task done
- Update tests when changing public function signatures
- Add new third-party libraries only if I confirm — list the alternatives first

**Don't:**
- Don't use `any` in TypeScript. Use `unknown` and narrow, or define a proper type.
- Don't add new dependencies without asking.
- Don't introduce new patterns when an existing pattern in this repo already solves the problem. Look for prior art first.
- [add project-specific don'ts]

## Memory files

- `MEMORY.md` — decisions log. Read at session start. Append on meaningful decisions and at session end.
- `ERRORS.md` — what didn't work and what did. Check before proposing approaches to similar problems.

(See `~/.claude/CLAUDE.md` for how I want these maintained.)
