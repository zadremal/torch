# torch — handoff

You have been handed the implementation of torch: a local application for analyzing Claude Code sessions. The design is finished and agreed with the owner, and the code has not been started.

---

## State as of 2026-11-10

| | |
|---|---|
| Repository | Branch `main`; there is no remote repository |
| Foundation | F1–F5 committed |
| Stage A | Merged in full: P1, P2, W1, A1, I1, I2, I3, W2, W3, I4 |
| K1 | Held 2026-11-09, results in spikes.md §6. The owner's database is `~/.torch/torch.db` (1002 sessions) |
| Stage B | Merged in full: A2, A3, W4, W5, W6 |
| K2 | Held 2026-11-09, results in spikes.md §7 |
| Stage C | Merged in full 2026-11-10: S1, E1, E2, L1, W7, T1, D1. Event reception and merging are wired into the indexer pass and into `torch start` |
| K3 | Held 2026-11-10, results in spikes.md §9: enrichment works on a new desktop session, `torch uninstall` restores the file byte for byte, T1 is green. The first wave is fully built |
| Checks | `bun run typecheck`, `bun test` (1235 tests), `bun run build` and `bun run e2e` (14 steps in headless Chrome, 12 s) are green on `main` |
| F6 checks | All seven held 2026-11-10 (spikes.md §3 and §8): hooks and OTel log export work in desktop sessions, identifiers match the transcript. Stage C is open; package S1 needs the owner's decision about metrics (below) |
| Owner's Claude Code settings | After K3 they were restored by `torch uninstall`, then at the owner's word `torch setup` was run again (2026-11-10): enrichment is on, the receiver is port 4820. Rollback is `torch uninstall`; the copy of the previous file is `~/.torch/backups/settings.json.2026-11-10T17-09-11-942Z`. `cleanupPeriodDays: 365` was added with the owner's consent; the copy of the previous file is in `~/.torch/backups/`. The temporary edit for the F6 checks (2026-11-10) was restored, the file matches the copy `settings.json.2026-11-10-before-spikes` |
| Consents | Commits to `main` and a run on the real history for K1 — received. The rest of the table below is still a separate question |

Findings on real data and the plan changes they caused — spikes.md §2, §4, §5.

### How to run

- `bun run dev:seed` — the API on the reference in-memory database (16 sessions), `bun run dev:web` — the UI with a proxy to it. The built-in browser configurations are in `.claude/launch.json` (`api-seed`, `web`, `web-fixtures`).
- `torch index | doctor | status | start` without overridden directories read `~/.claude/projects` and write `~/.torch`. Workers run them only with a temporary `TORCH_HOME` and a `config.json` in it (`transcriptsDir`, `desktopSessionsDir`). The server on the real database is the `torch` configuration in `.claude/launch.json`; check a screen with real data by DOM counters, without screenshots and without reading the page text.
- `bun run e2e` — the end-to-end run: build, `torch start` on synthetic transcripts with a temporary `TORCH_HOME`, all screens and live updating in the installed Chrome. Not part of `bun test`.
- Accepting a screen from a worker's branch: a temporary configuration in `launch.json` with `--cwd .claude/worktrees/<branch>/web`; remove it after acceptance.

### Checkpoint K3

Held, results in spikes.md §9. The order in which it went (useful for a repeat after enrichment edits), each step with the owner's consent:

1. `torch start` on the real database: migration 002 applies itself; measure the first pass (after startup the external subagent data is applied anew once) and a pass without changes.
2. `torch setup` on the real `~/.claude/settings.json`: show the owner the diff before writing. His `CLAUDE_CODE_ENABLE_TELEMETRY` is `"0"` and `OTEL_METRICS_EXPORTER` is set without a protocol — both rules of plan §7.1 will fire.
3. A new Claude Code desktop session (already open ones do not pick up an `env` edit): one or two tool calls, `/compact` if possible — the format of `PreCompact` and `PostCompact` is not confirmed by experiment.
4. Check by counters: events in `otel_events` and `hook_events`, attribute value types (numbers might arrive as strings), `duration_exact = 1` for model and tool calls, `permission_source`, instructions with `load_reason`, the enrichment mark, the session appearing in the UI within seconds, whether the `agent_id` of hooks events matches the agent identifier in the subagent file name.
5. Look at the model call mark on the timeline: after the duration is refined, `ts_start` stays an estimate, and the mark may end before `ts_end`.
6. Measure the cost recalculation after a price edit in Settings on the real database (24 thousand calls, 1002 sessions) — it goes over all sessions at once.
7. `torch uninstall`: the file is restored byte for byte (compare with the copy).

### Waiting for the owner's word after K1

- **Active time** (decision 30) includes waiting for the user's reply within a turn: 8 sessions are longer than 2 hours, two of 12 hours — one call that waited for a reply. Options and numbers — spikes.md §6. For now the rule is unchanged.
- **The ready-made cost from `cost-state`** (decision 8) is not suitable for reconciliation; the discrepancy is not shown.
- **Language of CLI/server messages — decided by the owner: everything is English.** CLI messages, server error messages and the 401, 403, 503 responses are in English, like the UI. Repository language rule: all comments, commit messages, docs and UI texts are in English.
- **A metrics exporter without a protocol** (spikes.md §8): the owner has `OTEL_METRICS_EXPORTER=otlp` without a protocol, and turning telemetry on with it breaks log export. Proposal for `torch setup`: when there is no protocol for metrics, add `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` and a metrics address pointing at the torch receiver, which answers 200 and stores nothing (a new route `/otlp/v1/metrics` in the contract). The other option is to leave it alone and report that enrichment from OTel will not work. The proposal was put to the owner on 2026-11-10, with no objections before stage C started: plan §7.1 and the contracts assume the first option; it will land on the real `settings.json` only at K3, with the diff shown.

### Open requests and debts

Consolidated before stage B: the reference database is obtained by running the pipeline over the reference transcript (`seedReference`), `Section` was raised to molecules, `useApi` can keep the previous data (`keepData`), the `testApi` helper for API tests.

Consolidated at K2: the `dto` examples are obtained by API calls on the reference database (`test/support/reference-dto.ts`); the W4 panel (`PanelContainer`) is wired into the timeline dock, the duplicate loader is removed; a load error with retry is the molecule `ErrorNotice`.

To consolidate before or during stage C:

- **Timeline mark.** `Timeline/Mark.tsx` and the mark base in `Timeline.module.css` duplicate the atom `TimelineMark`: the atom's `::before` pseudo-element costs about 0.1 ms of style calculation per mark. Remove `::before` from the atom (the track widens the click area), give it a `tabIndex` and a mark number, wrap it in `memo`, then delete the copy.
- **"Back to …" rolls back the mode, zoom and dock** changed after the last navigation: going back is a history step back, while the switches replace the current entry. They are kept in the artboard.
- **A selected mark without focus leaves the DOM on scroll;** "Show details" after closing does not scroll to the selected mark (W5 review, remarks 3 and 4).
- **Tests of timeline effects and of the page-to-organism wiring:** there is no DOM environment, 12 of 21 mutations survived (W5 review, remark 7). Close in T1 or set up a DOM environment.
- **Copies of formatting and labels:** `formatTick` in `Timeline/axis.ts`, `formatWindow` and `shortId` in three places, `formatBytes` in the panel, session status labels in the overview and the panel — candidates for `web/src/lib/format.ts`.
- **Duplicates between the overview and the panel in the API:** tool usage per agent, `TokenTotals`, parsing of `attachments_json` (`sessions.ts` and `items.ts`).
- **Tests reconciling the API with the examples** (`test/api/timeline.test.ts`, `items-reference.test.ts`, `contents.test.ts`) normalize the order of the example: after the examples are moved to the API, normalization is not needed.
- **Test helpers:** `parsed` and the reducer context in two `*.support.ts`; a temporary directory with `loadConfig` in three files; the server-rendering scaffolding via Vite in three UI tests.
- On the Dashboard screen the Custom date fields push the range switch one line below the heading.
- The call list in the agent panel is not virtualized (the main agent has hundreds and thousands of rows).

From stage C:

- **Not checked at K3** (spikes.md §9): `PreCompact`, `PostCompact` and `SessionEnd` from a real Claude Code; subagent events; API errors from two sources. Check on the owner's ordinary work after `torch setup`: look at the `hook_events` and `otel_events` counters in a day or two.
- **The owner runs torch himself** from the VS Code terminal (`bun run dev`, `bun run dev:server` with `--watch`) on the real database: an edit of the code in `main` restarts his server; ports 4820 and 5173 are taken.

- **A narrow API error gluing case:** two errors without a server response with the same attempt number less than a second apart, of which the transcript recorded one and the events were handled by different merges, will produce one record. Cured by the column `api_errors.otel_event_id` (worker E2's request, deferred).
- **Pair windows in the merge** (5 minutes for instructions, 10 minutes for compactions) were chosen by reasoning: verify at K3.
- **`api_request` of service requests** that are not in the transcript stay with `applied = 0`; passes without file changes go over only events younger than an hour.
- **`setup`:** a process abort between writing the state and the file on a repeated `setup` with a different port leaves two addresses with the old port after rollback; `torch start --port N` does not check the port against the one recorded in the settings.
- **Re-reading the price table by watching** after an edit from Settings is not covered by a test.
- **The `settings` example in `test/fixtures/dto`** is still set by hand: the route response carries the paths of the data directory.
- **The cost of the remaining mockup sessions** (`seedListSessions`) is written as a number, not computed from the table: after a recalculation from Settings on the dev server the totals change.
- **Duplicates:** active segments in `enrich/coverage.ts` and `reduce/durations.ts`; `--port` parsing in two branches of `cli.ts`; launching a real `torch start` process in `test/cli.test.ts` and `test/e2e/torch.ts`; reading SSE records in two tests; the path `<dataDir>/hooks/record.sh` is built in `cli.ts`, there is no field in `TorchConfig`.
- **The end-to-end run does not cover:** Export JSON, the Custom range, list sorting and pages, the project filter, timeline zoom, the prompt, file and net panels.
- **`ttft_ms`** arrives in `api_request`, but there is no column and no screen for it.

Decide later:

- Prompt file attachments lie in `attachment/file` lines (51 in the history), the parser skips them.
- `agents.files_read` also counts failed reads: `file_ops` is created for every call.
- Derived values are recalculated in the transaction of every session file: the first load of a session with 400 subagents takes 12 s. An option is one recalculation per session per pass.
- A moved file leaves a row of the old path in `source_files` with `missing_since`.
- With a `--host` outside loopback the OTel receiver ends up under the token, and Claude Code will not send the cookie: decide in stage C (E1).
- Blocks of an unknown type in `assistant` are skipped without counting.
- A file rewritten on the same inode and made longer is read from the old offset.
- Prices: the Batch API discount, the `inference_geo` multiplier and fast mode are not taken into account.
- Pressing Export JSON in a browser has not been checked (downloading a file needs the owner's consent); the file name is covered by a test.
- The order of the model response blocks at equal line times is set by a random uuid: there is no order column in `messages`.
- The dashboard's series and tables are counted by sessions started in the window: a session started before the window and continued in it is not visible in the window. There is no discrepancy on the current data (spikes.md §7).
- Compressing responses on the server is absent: the timeline of the largest session is 3.7 MB.

---

## Your role

You are the orchestrator (packages.md §1): you write the foundation yourself, hand out the rest to worker subagents, accept their work by branch and hold the checkpoints. The rules by which this is done are packages.md §2.

---

## What to read

1. This file, to the end.
2. [packages.md](packages.md), in full: this is your working document.
3. [plan.md](plan.md): right away §1, §2, §4 and §10; the other sections as needed: §3, §5, §6 before contracts and schema, §7 before stage C, §8 and §9 before the screen packages.
4. [references.md](references.md), on demand: documentation addresses, mockups, data paths, environment, unverified items.

---

## What is decided

The 39 decisions in plan.md §2 were made by the owner in the interview. They are the boundary of the task: a mismatch between a decision and reality (the data is arranged differently, a component does not fit) you raise with the owner with options, while continuing the code on the other packages.

The decisions you made yourself when writing the plan without discussion are listed below. They can be changed as appropriate, informing the owner:

- port 4820, one for the UI, the API and the OTel receiver;
- bodies are stored in the database by hash and compressed above 4 KB;
- there are no daily summary tables, the dashboard is computed by queries;
- the timeline state lives in the page address;
- the context window size is taken from the price table and raised if a call larger than the window is met;
- up to four workers at the same time;
- stages B and C start after K1;
- generalize at the second consumer;
- `MeterChart` in proportional mode for composite bars.

---

## What needs the owner's consent

Each item is a separate question; consent to one does not extend to the others.

| Action | When it will be needed |
|---|---|
| Commits to `main` | Consent received 2026-11-09: the foundation and one commit per accepted package |
| Creating a remote repository on GitHub (private) and a push | When the owner asks |
| Any edit of `~/.claude/settings.json` | The F6 checks and checkpoint K3 |
| Running torch on the real history | Checkpoints K1–K3 |

You alone read the real history, and only structurally: counters, line types, field names. Texts of prompts and outputs enter neither the repository, nor the workers' briefs, nor your messages.

---

## First steps

1. **Ask the owner for consent to commits.** Done when an answer is received.
2. **Write the foundation F1–F5** (packages.md §5). `CLAUDE.md` already exists: add the rules from packages.md §2 to it, keep the pointers. Done when `bun run typecheck` and `bun test` are green on the skeleton and the foundation is committed.
3. **Run stage A** along the graph of packages.md §7. Done: all ten packages accepted and merged.
4. **Start F6 with the owner in parallel** (plan.md §10.1): checks 1–6 need an edit of his settings and a live Claude Code session, check 7 only reads transcripts.
5. **Then follow the graph** of packages.md §7. At every checkpoint report to the owner: what works, what was found on real data, what changed in the contracts.

---

## Traps

Things that are not visible from the code and configuration.

- **Environment hints about Vercel and Next.js.** When a session starts in this directory, the Vercel plugin suggests Next.js, deployment and "start right away, without questions". This does not apply to torch: the stack is set by decision 10, the application is local.
- **Tokens are doubled.** One API response is recorded in the transcript as several lines with the same `requestId` and a repeated `usage`. Count by the unique `requestId`.
- **Project directory names start with a hyphen** (`-Users-…`). In shell commands write paths through `./` or after `--`, otherwise the name is read as a command flag.
- **All the owner's sessions were launched from the desktop app,** and 831 of 1001 lie in temporary directories: these are the app's service stubs, not the owner's work. By default they are hidden (decision 6).
- **The transcript format is internal and changes between versions.** An unknown line type or field is a normal situation: skip it, count it, show it in `torch doctor`.
- **The owner's `settings.json` already has `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_METRICS_EXPORTER`.** Log export is added by separate variables for logs, the existing ones are left as they are.
- **Old transcripts may disappear.** Claude Code deletes them by retention period (30 days by default), and `torch setup`, which raises the period, will appear only in stage C. The oldest files from 2026-08-06 are still in place. Suggest the owner raise `cleanupPeriodDays` by hand right now and do not postpone the initial load until K1.
- **A worker starts without context.** It knows only the brief and what the brief tells it to read. The done criterion in the brief is verbatim from the package entry.
- **A worker's report is a claim, not a fact.** Accept by branch: paths, type check, tests, criterion.

---

## Open questions

| Question | Whom to ask | What it blocks |
|---|---|---|
| Seven experimental checks (plan.md §10.1) | Hold with the owner | Stage C; check 7 is part of package I2 |
| Prices and context window sizes by model | Anthropic documentation | Package P2 |
| Whether the proportional `MeterChart` fits | Check in W1 | The organism `ProportionChart` |
| Which gateway is on the target system and where its logs are | Owner | The second wave, nothing now |

The full list of unverified items is references.md §9.
