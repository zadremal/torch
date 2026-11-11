# torch — work packages for subagents

What we are building is described in [plan.md](plan.md). This document covers how the work is divided between agents: who owns what, what depends on what, and by what criterion a package counts as done.

---

## 1. Roles

| Role | Who | What it does |
|---|---|---|
| Orchestrator | The main session | Writes the foundation, owns the contracts, launches workers, accepts packages, merges branches, runs checkpoints. The only one who reads the real history and touches `~/.claude`. |
| Worker | A subagent, one per package | Executes one package in its own worktree on its own branch and returns a report. |
| Reviewer | A fresh subagent | Receives the package brief and the branch diff. The worker's report is not passed to it. |

---

## 2. Rules

### Ownership

Each package has a list of paths that it creates and changes. Packages working at the same time own non-overlapping paths, so the branches merge without conflicts. An accepted package releases its paths: the next package gets them only if they are named in its ownership.

A package's tests live in `test/<area>/`, next to it by name, and are part of its ownership.

### Contract

`src/contracts/` holds the shared types: parsed lines, table rows, signatures of the ingest stages, the DTO of every route, selection types for the panel, SSE and enrichment events, the API provider plugin (`src/contracts/provider.ts`). The UI imports them via the `@contracts` alias.

The orchestrator owns the contracts (`src/contracts/provider.ts` among them), the provider plugins `src/providers/`, migrations, the root `package.json`, `CLAUDE.md`, `src/api/routes.ts`, `src/api/context.ts`, `src/ingest/reduce/contents.ts` and `test/support/`. A worker who is hindered by a contract stops and returns a **contract change request**: what does not fit, what change is needed, which packages it affects. The orchestrator edits the contract on `main` and restarts the affected ones.

### Skeleton

The foundation creates every file of the plan as a stub with a signature from the contract: the type check passes from day one, routes answer 501, screens show an empty page. The worker fills in the stubs rather than inventing a structure. The wiring of the modules (the route list, the UI router) is already written in the skeleton.

### Data

Workers operate on synthetic data: `test/support/transcript.ts` builds transcripts, `test/support/seed.ts` fills the database with rows, `test/fixtures/dto/` holds the API responses for the UI (contents: `test/fixtures/dto/README.md`). The reference session per the mockup scenario exists in all three forms: `test/support/reference*.ts`. The orchestrator runs the real history through `torch doctor` at checkpoints and turns the findings into new synthetic examples.

A consequence for parallelism: reducers are tested on built transcripts, the API on a database from `seed`, screens on responses from `dto`. The three layers do not wait for one another.

### Principles

The code follows DRY, KISS and YAGNI in the sense set out in plan.md §4.2; the UI follows atomic design per plan.md §9.4. Three consequences for working in packages:

- **Shared knowledge is taken from its single place** (the table in plan §4.2). If what is needed is not there, it is a contract change request.
- **A new component of a screen package lives inside its ownership**: `pages/<name>/components/` or the directory of its own organism. The orchestrator lifts it to the shared level (`atoms/`, `molecules/`) at a checkpoint, once a second consumer has appeared.
- **A worker names duplication with another package in the report** and does not touch the other package's code. The orchestrator reconciles it at a checkpoint.

### Isolation and parallelism

Each worker is launched with `isolation: "worktree"`. This requires the foundation to be committed to `main` before the first launch. Up to four workers run at once: the bottleneck is acceptance, not writing.

### Acceptance

The orchestrator accepts a package itself, from the branch rather than from the report:

1. `git diff --name-only main...<branch>` — all paths are inside the package's ownership.
2. `bun run typecheck` and `bun test` — green on the branch merged with the current `main`.
3. The package's done criterion from section 5 is met in full.
4. The plan §4.2 principles are observed: shared knowledge is not described a second time; there is no code, parameter or dependency without a consumer in the first wave; every new dependency is named in the report.
5. For packages marked "review" — a reviewer's conclusion with no open remarks. The reviewer reads plan §4.2 and §9.4 together with the brief.
6. For screens — a snapshot of the page on data from `dto` is checked against the artboard and the table of deviations (plan §9.3); each component sits at the level it corresponds to per the plan §9.4 table, and API requests and address state are found only in pages.

An accepted package is merged into `main` as one commit.

---

## 3. Worker brief

The orchestrator assembles the brief from the package entry. It does not retell the specification, but names the sections.

```
Package <ID> "<name>" of the torch project.

Goal: <one sentence>.

Read first:
- CLAUDE.md
- docs/packages.md, sections 2 and 4, and the entry for package <ID>
- docs/plan.md, sections <numbers>
- <contract files>
- <artboard from docs/design/, if the package is about a screen>

Ownership: <paths>. You only read everything else.

Done when: <criterion from the package entry>.

Outside the package: <what the neighbors do themselves>.
```

---

## 4. Worker report

```
Package <ID>: done | stopped

Done: <by criterion items, each with a test name or a check command>
Deviations from the plan: <what and why> | none
Contract change requests: <...> | none
New dependencies: <package and why> | none
Noticed duplication and shared-component candidates: <...> | none
Not verified: <...> | none
```

---

## 5. Work

Marks: **review** — a reviewer is needed; **↓** — a simpler model is enough.

### Foundation — orchestrator, sequential

| No. | Work | Result |
|---|---|---|
| F1 | Repository skeleton | Root `package.json` with the `web` workspace, `tsconfig`, scripts `typecheck`, `test`, `dev`; the existing `CLAUDE.md` extended with the rules from section 2 and pointers to plan §4.2 and §9.4 |
| F2 | Contracts | `src/contracts/`: `lines.ts`, `rows.ts`, `pipeline.ts`, `api.ts`, `selection.ts`, `enrich.ts`, `events.ts`, `constants.ts` |
| F3 | Database | A migration with the schema from plan.md §5, `src/db/db.ts`, `src/config.ts` |
| F4 | Test supports | `test/support/transcript.ts`, `test/support/seed.ts`, the reference session per the mockup scenario (5 agents, errors, follow-up prompts) in three forms: transcript, database rows, `dto` responses |
| F5 | Skeleton | Stubs of all files from plan.md §4.1, `src/api/routes.ts` with all routes |
| F6 | Experimental checks | plan.md §10.1, together with the machine owner; run in parallel with stage A |

Done when `bun run typecheck` and `bun test` are green on the skeleton and the foundation is committed.

The F6 checks block only stage C: the hooks format is needed by S1, the OTel behavior by E1 and E2. Check 7 (the `instructions` lines) is done, the result is in spikes.md §3: I2 fills `instructions_loaded` from the transcript.

`src/ingest/reduce/contents.ts` and `src/api/context.ts` are written in the foundation and stay with the orchestrator: several packages use them at once.

### Stage A — core, list and overview

| ID | Package | Depends | Ownership | |
|---|---|---|---|---|
| P1 | Parser and reader | F | `src/ingest/parse.ts`, `src/ingest/reader.ts` | review |
| P2 | Cost and prices | F | `src/ingest/reduce/cost.ts`, `prices.default.json` | ↓ |
| W1 | UI skeleton | F | `web/` except `web/src/pages/*/`, `organisms/Timeline/`, `organisms/DetailPanel/` | |
| A1 | API: sessions and overview | F | `src/api/filters.ts`, `src/api/sessions.ts`, `src/api/projects.ts`, `src/api/export.ts` | |
| I1 | Calls reducer | P1 P2 | `src/ingest/reduce/{modelCalls,toolCalls,fileOps,external,apiErrors,compactions}.ts` | review |
| I2 | Structure reducer | P1 | `src/ingest/reduce/{session,agents,prompts,messages,instructions}.ts`, `src/ingest/titles.ts` | review |
| I3 | Derived values | F | `src/ingest/reduce/{durations,status,context,totals}.ts` | review |
| W2 | Sessions screen | W1 | `web/src/pages/sessions/` | ↓ |
| W3 | Session detail screen | W1 | `web/src/pages/session-overview/` | ↓ |
| I4 | Indexer and CLI | P1 P2 I1 I2 I3 A1 | `src/ingest/discover.ts`, `src/ingest/index.ts`, `src/cli.ts`, `src/server.ts` | review |

Launch order: P1, P2, W1, A1 → I1, I2, I3, W2, W3 → I4.

**P1.** Read: plan §3.1, §6.1; spikes.md §2, §3; `lines.ts`, `pipeline.ts`.
Done when: every line type from plan §3.1 is parsed into a type from `lines.ts` and has a test; an unknown line type and an unknown field pass without an exception and are counted in the unknowns counter; reading from a given offset returns only complete lines, a truncated last line stays until the next pass; the tests cover an appended, a shortened and a replaced file.

**P2.** Read: plan §6.2 (cost, context window); `pipeline.ts`.
Done when: `prices.default.json` has a price for each kind of token and a window size for every current model from the Anthropic documentation, with the page address and date in the file itself; the calculation for a call with a 5-minute and a one-hour cache matches the manual one in a test; an unknown model gives `null`.

**W1.** Read: plan §8, §9.1, §9.3, §9.4; `api.ts`, `selection.ts`; all artboards in `docs/design/` (the header, navigation, blocks repeated on several screens).
Done when: the app builds and opens; all six routes from plan §9.1 exist as stubs on the `AppShell` and `SessionLayout` templates; the header and navigation match the artboards; the atoms and molecules from the plan §9.4 table exist at their levels, each used on at least two artboards; Carbon Charts is installed, its styles are attached at the entry point, the `BarChart` and `ProportionChart` organisms render data from `dto` in the series colors from the mockup and remain the only place the library is imported; a variables file for values outside the Carbon tokens is created; the API client is typed by `api.ts` and has a mode that serves responses from `test/fixtures/dto/` for every route of plan §8; the formatting of tokens, money and durations is covered by tests on values from the mockups.

**A1.** Read: plan §5, §8, §6.2 (temporary directories, name); `api.ts`, `rows.ts`.
Done when: the translation of session filters to SQL lives in `filters.ts` and is suitable for the dashboard (period, project, temporary directories); every query parameter of the list from plan §8 has a test on a database from `seed`, including sorting by each column, pages and hiding temporary directories; the overview response fills every field of its DTO; the export returns the session with all agents and calls.

**I1.** Read: plan §3.1, §5, §6.2; spikes.md §2; `lines.ts`, `rows.ts`, `pipeline.ts`; `src/ingest/reduce/cost.ts`, `contents.ts`.
Done when: every plan §6.2 rule about model calls, tools, the call target, statuses, file operations and external requests has a test; a response of several lines with one `requestId` gives one call with the tokens from the last line; a call without a result gets status pending; a call without `toolUseResult` (a subagent file) gets the path, URL and an estimate of changed lines from the input; an `assistant` line with `isApiErrorMessage` gives a record in `api_errors` with a status; bodies are put into `contents` via `putContent`; lines that arrived in two passes give the same database as in one; reprocessing the same lines does not change the database.

**I2.** Read: plan §3.1, §3.2, §5, §6.2; spikes.md §2, §3; `lines.ts`, `rows.ts`, `pipeline.ts`; `src/ingest/reduce/contents.ts`.
Done when: a subagent is linked to the parent call by `meta.json` and by `agentId`, a nested one gets a depth and a parent; the session name is chosen by the priority of decision 7, each priority level is covered by a test; `name_lower` is filled together with the name; the first prompt is marked original, the rest follow_up; the model's text and thinking go into `messages`; `instructions` and `nested_memory` lines go into `instructions_loaded` with the size and a token estimate; the temporary directory flag is covered by a test; lines that arrived in two passes give the same database as in one.

**I3.** Read: plan §5, §6.2; `rows.ts`, `pipeline.ts`. Works on database rows from `seed`, does not parse transcripts.
Done when: every plan §6.2 rule about active time, model time, session status, First / Last / Peak, the context breakdown, agent and session totals has a test; the sum of the breakdown categories equals the peak size; a session with one inexact call gets `model_ms_exact = 0`; the recalculation is idempotent.

**W2.** Read: plan §9.3; `docs/design/Main.dc.html`; `api.ts`.
Done when: the screen matches the artboard on responses from `dto`; search, all four artboard filters, the project filter, the temporary directories toggle, sorting by each column, pages, the empty state and reset work; the filter state lives in the page address.

**W3.** Read: plan §9.3; `docs/design/SessionDetail.dc.html`; `api.ts`.
Done when: the screen matches the artboard on responses from `dto`; six tiles, Token usage via `ProportionChart`, the original prompt with a follow-up expansion, an agents table with indentation of nested ones are shown; the Running status and the enrichment mark are displayed; Export JSON downloads a file.

**I4.** Read: plan §4, §6.1, §7.3; `pipeline.ts`.
Done when: every step of plan §6.1 is covered by an integration test on a directory of synthetic transcripts; `torch index` twice in a row gives the same database; a vanished file leaves the session with `transcript_present = 0`; `torch doctor` prints unknown types and fields without line contents; `torch status` and `torch start` work; the server serves the built UI and the routes from `routes.ts`.

### Stage B — timeline and dashboard

Launched after checkpoint K1: real data will first correct the contracts.

| ID | Package | Depends | Ownership | |
|---|---|---|---|---|
| A2 | API: timeline and panel | K1 | `src/api/timeline.ts`, `src/api/items.ts`, `src/api/contents.ts` | review |
| A3 | API: dashboard | K1 | `src/api/dashboard.ts` | |
| W4 | Detail panel | K1 | `web/src/components/organisms/DetailPanel/`, `web/src/pages/panel/` | |
| W5 | Timeline | K1 | `web/src/components/organisms/Timeline/`, `web/src/pages/session-timeline/` | review |
| W6 | Dashboard screen | K1 | `web/src/pages/dashboard/` | ↓ |

All five run in parallel. W5 connects W4's panel by the types from `selection.ts`; until W4 is merged, W5 works with its stub from the skeleton.

**A2.** Read: plan §5, §8, §9.2, decisions 13 and 31; `api.ts`, `rows.ts`.
Done when: the timeline response contains all six tracks and the gap map; a gap appears only on an idle period longer than 5 minutes with no calls running, both conditions are covered by tests; each of the six panel kinds is served by its own route with a filled DTO; a body by identifier is returned unpacked; a session without a transcript serves texts from the database.

**A3.** Read: plan §8, decisions 6 and 29; `api.ts`; `src/api/filters.ts`.
Done when: session selection goes through `filters.ts`; each of the five ranges gives the correct window bounds, the number of bars and the delta against the previous window in a test with a fixed "today"; the totals for the period equal the sum over the session list with the same filters; five tops, the tables by tool and model, and the token mix are filled; temporary directories are excluded by default.

**W4.** Read: plan §9.1, §9.3; `docs/design/DetailPanel.dc.html`; `selection.ts`, `api.ts`.
Done when: all six kinds match the artboard on responses from `dto`; the context at the peak is shown via `ProportionChart`; transitions between kinds, the "Back to …" button, the "Errors only" filter, docking left, right and bottom, and closing work; a separate tab opens the same kind by address; every plan §9.3 deviation that relates to the panel is implemented.

**W5.** Read: plan §9.2, §9.3; `docs/design/Timeline.dc.html`; `selection.ts`, `api.ts`.
Done when: the Compact and Expanded modes match the artboard on responses from `dto`; zoom, the cursor, track selection and dimming of other agents' marks when an agent is selected work; gaps are drawn with a duration label; each mark is a button reachable from the keyboard; selection, dock, mode and zoom are read from the address and written to it; a session from `dto` with a thousand calls scrolls without jerking.

**W6.** Read: plan §9.3; `docs/design/Dashboard.dc.html`; `api.ts`.
Done when: the screen matches the artboard on responses from `dto` for all five ranges, including the date fields of Custom; both charts go through `BarChart`, Token mix through `ProportionChart`, the screen itself does not import Carbon Charts; tooltips on the bars, links from the tops to the session and highlighting of an error share above 5% work.

### Stage C — live update, enrichment, setup

Launched after K2. S1 and E1 do not depend on the screens and take free slots earlier, as soon as their F6 checks are ready.

| ID | Package | Depends | Ownership | |
|---|---|---|---|---|
| S1 | Setup and hooks | F, F6 | `src/setup/`, `hooks/record.sh`, `setup.sh` | review |
| E1 | Event intake | F, F6 | `src/enrich/otlp.ts`, `src/enrich/hooks.ts`, `src/enrich/networkSource.ts`, `src/enrich/coverage.ts`, `src/api/otlp.ts` | |
| E2 | Enrichment merge | F, F6 | `src/enrich/merge.ts` | review |
| L1 | Live update | K2 | `src/ingest/watch.ts`, `src/api/events.ts`, `web/src/lib/live.ts`, wiring in the screens | |
| W7 | Settings | K2 | `src/api/settings.ts`, `web/src/pages/settings/` | ↓ |
| T1 | End-to-end run | L1 W7 | `test/e2e/` | |
| D1 | README | S1 | `README.md` | ↓ |

**S1.** Read: plan §7.1, §7.2, decision 27; the F6 results.
Works only with a copy of `settings.json` in a temporary directory: the file path is a parameter.
Done when: the diff display, confirmation, backup and write are covered by tests; a repeated run does not change the file; a file with other people's hooks and other people's `env` variables keeps them untouched; `uninstall` after `setup` returns the file byte for byte; `record.sh` puts an event atomically and passes the `sh -n` check.

**E1.** Read: plan §3.3, §3.4, §6.3, §7.2; `enrich.ts`.
Done when: an OTLP http/json packet with each of the four plan §3.3 events is parsed and lands in `otel_events`; an unknown event is saved without an error; files from the spool are accepted and deleted, the size of the instructions file is read on intake; the receiver working windows are written with a heartbeat, an abnormal termination leaves the window closed at the last heartbeat.

**E2.** Read: plan §6.2 (the enrichment mark), §6.3; `enrich.ts`, `rows.ts`. Works on raw events and rows from `seed`.
Done when: every plan §6.3 rule has a test; an event without a pair stays with `applied = 0` and is applied once the line appears; a duplicate API error from two sources gives one record; the full, partial and none mark is set by the coverage of active intervals; a repeated merge changes nothing.

**L1.** Read: plan §4, decisions 2 and 36; `events.ts`.
Done when: an appended transcript line leads to an SSE event and an update of the open list, overview and timeline without a reload; a running session shows Running and moves to Completed by the status rule; an SSE disconnect recovers by itself.

**W7.** Read: plan §8, decision 37; `api.ts`.
Done when: the page shows and saves the price table, shows the data paths, the state of both enrichment channels and the retention period; editing a price changes the cost after the recalculation.

**T1.** Read: plan §11.
Done when: the run brings up torch on a database from synthetic transcripts and goes through all five screens and Settings: opening, one filter each, the transition list → overview → timeline → panel → separate tab.

**D1.** Read: plan §7.
Done when: the README describes installation, launch, every change on the machine and its rollback, and every command in it has been executed on a clean clone.

---

## 6. Checkpoints

Run by the orchestrator on `main` after a stage is merged. Findings on real data turn into synthetic examples and contract edits before the next stage is launched. Here the orchestrator also reconciles the duplication named in the reports and lifts to the shared level the components that have gained a second consumer.

| Point | After | Check |
|---|---|---|
| K1 | Stage A | Initial load of the entire history without errors. `torch doctor` shows no unhandled line types that affect the counters. Tokens of sessions with `cost-state` match `modelUsage`. Any session opens in the list and the overview, the numbers agree. |
| K2 | Stage B | A session with hundreds of calls and subagents scrolls on the timeline. Input and output are reachable from any mark. The dashboard totals equal the sum over the list. |
| K3 | Stage C | After `torch setup` on the real `settings.json` (with the owner's consent) a new session shows exact latency, durations, the permission source and instructions. A new session appears in the UI within seconds. `torch uninstall` returns the file. T1 is green. |

---

## 7. Dependencies

```
F ─┬─ P1 ─┬─ I1 ─┐
   │      └─ I2 ─┤
   ├─ I3 ────────┤
   ├─ P2 ────────┼─ I4 ─ K1 ─┬─ A2 ─┐
   ├─ A1 ────────┘           ├─ A3 ─┤
   ├─ W1 ─┬─ W2 ─────────────┤      │
   │      └─ W3 ─────────────┤      ├─ K2 ─┬─ L1 ─┬─ T1 ─ K3
   │                         ├─ W4 ─┤      └─ W7 ─┘
   │                         ├─ W5 ─┤
   │                         └─ W6 ─┘
   └─ F6 ─┬─ S1 ─ D1 ─────────────────────────────── K3
          ├─ E1 ──────────────────────────────────── K3
          └─ E2 ──────────────────────────────────── K3
```
