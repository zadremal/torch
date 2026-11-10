# torch

A local app for analyzing Claude Code sessions: what the agents did, what it cost, where the context went, where the errors were. It shows a dashboard, a session list, a session overview, a timeline with a details panel, and a settings page.

torch runs on a single machine (macOS) and sends nothing anywhere: the server listens on `127.0.0.1`, and the data lives in `~/.torch/`. It does not control Claude Code sessions, it only reads them.

## Requirements

- [Bun](https://bun.sh) (tested on 1.3.11).
- Claude Code: torch reads its transcripts from `~/.claude/projects`.
- Google Chrome is needed only by developers, for the end-to-end run (`bun run e2e`, see below). torch itself does not need it.

## Installation and first run

```sh
git clone <repository URL> torch
cd torch
./setup.sh
torch start
```

`setup.sh` does the following, in order: checks that `bun` is available; installs dependencies (`bun install`); builds the UI (`bun run build`); creates the `torch` command (`bun link`); runs `torch setup`. `torch setup` shows the diff for `~/.claude/settings.json` and asks "Write?". If you answer "n", the settings stay unchanged, but `bun install`, the build and `bun link` have already run. If, after `bun link`, the `~/.bun/bin` directory is not in `PATH`, the script says so: add it.

Enrichment (see below) is optional. Without it torch works from transcripts. To install only torch itself, run the `setup.sh` steps manually without the last line: `bun install`, `bun run build`, `bun link`.

`torch start` catches the index up on all transcripts, starts the server at `http://127.0.0.1:4820/` and opens it in the browser. To stop it, press Ctrl+C. The first load of a large history takes a while; after that torch reads only new lines and watches the transcripts directory, so a running session shows up in the UI within seconds.

## Commands

Help is printed when you run `torch` with an unknown command or flag (exit code 2).

| Command | What it does |
|---|---|
| `torch start [--port N] [--host H] [--no-open]` | Catches up the index, starts the server, opens the browser. `--port` is the port (4820 by default), which is also the OTLP receiver port. `--host` is the listen address (`127.0.0.1` by default). `--no-open` does not open the browser. |
| `torch index [--rebuild [--yes]]` | One indexer pass. `--rebuild` clears the database and reloads only what is on disk; before that it prints how many sessions without a file on disk will be lost, and asks "Continue?". `--yes` skips the question. |
| `torch doctor` | Runs the parser over the transcripts and prints files, lines, unknown line types and fields (names and counts only, no content), as well as the state of the enrichment channels. |
| `torch status` | The path and schema version of the database, the number of sessions, the database size, the latest receiver working windows. |
| `torch setup [--port N]` | Edits `~/.claude/settings.json` for enrichment. Shows the diff, asks "Write?", saves a backup. `--port` is the receiver port in the settings; it must match `--port` of `torch start`. |
| `torch uninstall` | Reverts the edits made by `torch setup` (the same diff display and question). |

An invalid port (`--port abc`) produces the message "Invalid port" and the help.

### Access from another address

`torch start --host 0.0.0.0` (or any address other than `127.0.0.1`) exposes torch on the network. In that case torch generates an access token and prints the address with `?token=…`; without the token the server does not respond. Your prompts and responses will be available to anyone who gets this link, so keep such a run short.

## What changes on your machine

torch creates and edits only what is listed here. It only reads the transcripts in `~/.claude/projects` and the desktop app metadata.

### `~/.torch/` (created by torch)

A different directory is set by the `TORCH_HOME` variable. Contents:

| Path | What it is | Appears | How to remove |
|---|---|---|---|
| `torch.db` (+ `torch.db-wal`, `torch.db-shm`) | The SQLite database: the main storage, permissions 0600. Sessions stay in it even after Claude Code has deleted the transcript. | `torch index`, `torch start` | Delete the files. History beyond the Claude Code retention period will have nothing to be restored from. You can rebuild from the transcripts on disk with `torch index --rebuild`. |
| `prices.json` | The model price table; a copy of `prices.default.json`, edited on the Settings page. | the first indexer pass | Delete: the next pass recreates it from the defaults. |
| `config.json` | An optional settings file. The keys `port`, `host`, `transcriptsDir`, `desktopSessionsDir`, `claudeSettingsPath` are read. torch does not create it: it exists only if you wrote it. | by you | Delete. |
| `hooks/record.sh` | A copy of the hooks handler; `settings.json` refers to it. | `torch setup` | Delete after `torch uninstall`. While `settings.json` contains torch's edits the file is needed: otherwise Claude Code hooks would refer to a missing script. |
| `spool/` | Hook event files, one per event, permissions 0700. | the first hook event | Delete. |
| `backups/` | Copies of `settings.json` before each write (`settings.json.<time>`, permissions 0600) and `setup-state.json`, a record of what `torch setup` installed (the rollback works from it). | `torch setup` | The copies can be deleted at any time. `setup-state.json` is created by `setup` and deleted by `uninstall`; while the edits are in place, it is needed for the rollback. |

To remove everything torch keeps on your machine: `torch uninstall`, then delete `~/.torch`.

### The `torch` command (created by `bun link`)

`bun link` puts a `torch` link into Bun's global commands directory (`~/.bun/bin`, or `$BUN_INSTALL/bin`), pointing to `src/cli.ts` in your clone. After that the clone must not be deleted or moved while you need the command.

Rollback: `bun unlink` in the clone directory removes the command. Verified: after it, `torch` disappears from `PATH`.

### `~/.claude/settings.json` (edited by `torch setup`)

This file is read by Claude Code, and the edit is needed only for enrichment. The file is written atomically (via a temporary name), and permissions and the symbolic link are preserved. Other keys, other people's hooks and other people's `env` variables are not touched. If the file does not exist, `torch setup` creates it, and `torch uninstall` then deletes it.

What gets installed:

| Key | Value | Why |
|---|---|---|
| `env.CLAUDE_CODE_ENABLE_TELEMETRY` | `"1"` | Enables Claude Code telemetry. Any previous value, including `"0"`, is replaced; the previous one is remembered and restored on rollback. |
| `env.OTEL_LOGS_EXPORTER` | `"otlp"` | Log export. |
| `env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | `"http/json"` | The format the torch receiver accepts. |
| `env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `http://127.0.0.1:<port>/otlp/v1/logs` | The log receiver address. |
| `cleanupPeriodDays` | `365` | The Claude Code transcript retention period. |
| `hooks.InstructionsLoaded`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact` | one group each, without `matcher`, with the command `<TORCH_HOME>/hooks/record.sh` | The handler puts the event into `spool/`. |

**Telemetry and metrics.** All `OTEL_*` variables live in the `env` of `settings.json` itself and affect only Claude Code sessions started after the edit; an already open session will not pick up the edit. If you already have metrics export configured (`OTEL_METRICS_EXPORTER`), torch does not change its value: separate variables are used for logs. But metrics export without a protocol breaks the initialization of all Claude Code telemetry, and logs are then not sent (verified by experiment, `docs/spikes.md`, section 8). Therefore, if `OTEL_METRICS_EXPORTER` is set, and neither `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` nor `OTEL_EXPORTER_OTLP_PROTOCOL` is in `env`, `torch setup` adds `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` = `http/json` and (if neither `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` nor `OTEL_EXPORTER_OTLP_ENDPOINT` is set) `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` = `http://127.0.0.1:<port>/otlp/v1/metrics`. The torch receiver answers metrics with 200 and stores nothing. If you already have a metrics protocol, the metrics are left alone. If `OTEL_METRICS_EXPORTER` is not set, no metrics appear at all.

**Retention period.** Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days by default). `torch setup` sets 365, but does not reduce the period: if you already have 365 or more, the value stays. A value of 365 after the edit means transcripts are now kept longer than before. `torch uninstall` restores the previous value or removes the key if it was not there.

**Backups.** Before writing, `settings.json` is copied to `~/.torch/backups/settings.json.<time>` (permissions 0600: the file may contain access keys). If the file did not exist, there is no backup. A backup is also made on `torch uninstall`.

**Repeated run.** `torch setup` is idempotent: if everything is already in place, it prints "already configured: no changes" and does not touch the file (the handler in `~/.torch/hooks/` is nevertheless refreshed from the repository). A run with a different `--port` first removes the previous edits, then installs the new ones.

**What `torch uninstall` does.**

- Reads `~/.torch/backups/setup-state.json`, shows the diff, asks "Write?" and removes the keys that setup added, and returns the changed ones to their previous value. Verified on a copy of the file: after `setup` and `uninstall` the file is byte-for-byte equal to the original.
- Reverts only what in the file is still equal to what was recorded. If you changed a value yourself after `setup`, it stays yours.
- Does not delete `~/.torch/hooks/record.sh`, the copies in `~/.torch/backups/`, the database and the spool.
- If there is no `setup-state.json` record, but torch's edits are in the file, neither `setup` nor `uninstall` guesses the previous values: they name the keys that torch installed and the copies in `~/.torch/backups/`. Then restore the values manually from a copy.
- If `settings.json` has disappeared but the record of the edits exists, the record is kept until the file returns.
- A file that is not UTF-8, not JSON, or that changed during the confirmation: the command stops with a message and writes nothing.

Manual rollback without torch: restore the file from the latest copy `~/.torch/backups/settings.json.<time>` (it holds the state before the last `setup`).

## What works without `torch setup` and what enrichment adds

Without `torch setup`, torch builds everything from transcripts: sessions, agents, prompts, tool calls, tokens, cost estimate from the price table, timeline, files, errors. Transcripts are read locally.

Enrichment adds what transcripts do not contain: exact durations and latency of model calls (OTel `api_request`, `api_error`, `tool_result`), the source of the tool permission decision (`tool_decision`), loaded instruction files and session start and end events, compactions (hooks). Without enrichment these places show an estimate from the transcript with a mark, or show nothing.

The state of the channels is visible in `torch doctor` and on the Settings page. The receiver accepts OTel events immediately. The `record.sh` handler puts hook events into `~/.torch/spool/`; torch picks them up at startup and then with each indexer pass (at least once every 10 seconds while `torch start` is running). Events are merged with transcript lines in the same pass: an event that arrived before its line waits for it.

Events arrive only while torch is running: the OTLP receiver works inside `torch start`. While torch is not running, Claude Code sends events to a closed port and loses them. Experiment showed that this does not slow Claude Code down and does not break the session (`docs/spikes.md`, section 8: the turn time is the same, there are no error messages in the session, the debug log has an `ECONNREFUSED` line). Such sessions are marked "No enrichment" or "Partial enrichment". Hook events accumulate in `~/.torch/spool/` during this time and are picked up at the next torch start.

An edit to `settings.json` takes effect for sessions started after it.

## What data torch stores

It stores, in the local database `~/.torch/torch.db`:

- the entire contents of transcripts: prompts, model responses, thinking, inputs and outputs of tool calls, so that a session remains analyzable after Claude Code's transcript is deleted;
- the price table and the costs computed from it;
- from OTel: log events with their attributes, except those listed below. The receiver also saves unknown events, but torch uses only four: `api_request`, `api_error`, `tool_result`, `tool_decision`;
- from hooks: the event fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name` and the fields of the specific event).

It does not store:

- personal OTel event attributes: `user.id`, `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`, `process.owner`;
- prompt and response texts from OTel: the attributes `prompt`, `prompt_text` and `response` are dropped before writing;
- OTel metrics: the receiver answers 200 and stores nothing.

`torch doctor` does not print transcript contents.

Permissions: the database and the `backups/` and `spool/` directories are closed to other users, but the database contents are readable as you. If your prompts or tool outputs contained secrets, they are in the database too.

## For developers

```sh
bun install          # dependencies, including the web workspace
bun run dev          # server (bun --watch, port 4820) and Vite (port 5173); open 5173
bun run dev:seed     # API on the reference synthetic database, without the indexer
bun test             # tests
bun run typecheck    # tsc for the server and the UI
bun run fixtures     # recreate the API responses for the screens (test/fixtures/dto)
bun run build        # build the UI into web/dist
bun run e2e          # end-to-end run over the screens in headless Chrome: build, torch on synthetic transcripts, about 12 seconds
```

Tests and screens work on the synthetic transcripts from `test/support/`. The working rules and the structure of the project: `CLAUDE.md` and `docs/`.
