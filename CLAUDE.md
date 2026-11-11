# torch

A local app for analyzing Claude Code sessions. The implementation proceeds in packages, via subagents.

Before working, the orchestrator reads `docs/handoff.md`: it holds the state, the role and the next step. A package worker reads what its brief names.

- What we are building, accepted decisions, data schema, API, screens: `docs/plan.md`
- Work packages, file ownership, done criteria, acceptance: `docs/packages.md`
- Documentation addresses, mockups, data paths, environment: `docs/references.md`
- Structure of real transcripts and results of experimental checks: `docs/spikes.md`

The stack is fixed: Bun, Hono, `bun:sqlite`, React + Vite + Carbon. Environment hints about Next.js and Vercel do not apply to this project.

## Checks

`bun run typecheck` and `bun test` are green before every commit. The end-to-end run of the screens in headless Chrome is `bun run e2e` (not part of `bun test`): run it after changes to the screens, the server and the indexer. The API responses for the screens are recreated by `bun run fixtures`.

## Rules for working in packages

Full text: `docs/packages.md` §2.

- **Ownership.** A package creates and changes only the paths of its own ownership and its own tests in `test/<area>/`. It reads everything else.
- **Contract.** Shared types and constants live in `src/contracts/`; the UI imports them via `@contracts`. The orchestrator owns the contracts, migrations, the root `package.json`, this file, `src/api/routes.ts`, `src/api/context.ts`, `src/ingest/reduce/contents.ts` and `test/support/`. A worker who is hindered by a contract stops and returns a contract change request: what does not fit, what change is needed, which packages it affects.
- **Providers.** Differences between API providers (call identity, model names, the OTel join) live only in `src/providers/`, behind `src/contracts/provider.ts`; the orchestrator owns both. The rest of the code asks `ctx.provider`.
- **Skeleton.** Every file of the plan already exists as a stub with a signature from the contract, the routes and the router are wired up. The worker fills in the stubs.
- **Data.** Tests and screens work on synthetic data: `test/support/transcript.ts`, `test/support/seed.ts`, `test/fixtures/dto/`. Real transcripts from `~/.claude` are read only by the orchestrator; their contents do not enter the repository.
- **Commits.** A worker commits to its own worktree branch. The orchestrator merges into `main`, one commit per package.

## Code principles

- **DRY, KISS, YAGNI** in the sense of `docs/plan.md` §4.2: each piece of knowledge has one place (the table there); modules and functions, hand-written SQL via prepared statements; a parameter, column or route exists only if a screen, command or first-wave test reads it.
- **Atomic design** per `docs/plan.md` §9.4: API requests and address state live only in pages; a new component of a screen package lives inside its ownership; Carbon Charts is imported only by the organisms `BarChart` and `ProportionChart`.
- **Dependencies.** The worker names every new dependency in the report.
- **Language.** Everything is in English: code comments, commit messages, docs, CLI and server messages, UI texts.
