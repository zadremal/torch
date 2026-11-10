# torch — references

A reference: where things are and where they came from. Read on demand, not in full. Compiled 2026-11-09.

---

## 1. Project documents

| File | What is in it | When to read |
|---|---|---|
| [handoff.md](handoff.md) | State, role, first steps, what requires the owner's consent | First |
| [plan.md](plan.md) | What we are building: boundaries, 39 decisions, data, architecture, schema, calculation rules, API, UI | By the sections a package names |
| [packages.md](packages.md) | How we build: roles, rules, brief template, packages with ownership and criteria, checkpoints | In full before launching the first worker |
| `spikes.md` | Results of experimental checks | Will appear during F6 |
| `design/` | Five mockup artboards and `canvas.json` | For screen packages |

---

## 2. Mockups

**Source:** the canvas "Session debugger", an artifact of the Design type: `https://claude.ai/artifact/7QbC5WX1XaHxAWFYtLQNhL`. Private, owned by the project owner; read with the Artifact tool (`action: "read"`, files under `project/`). Local copies were taken from version `1794277263-5727`.

| Artboard | File in `docs/design/` | Size | torch route | Package |
|---|---|---|---|---|
| Dashboard | `Dashboard.dc.html` | 1440×1640 | `/` | W6 |
| Sessions list | `Main.dc.html` | 1440×1120 | `/sessions` | W2 |
| Session detail | `SessionDetail.dc.html` | 1440×1480 | `/sessions/:id` | W3 |
| Session timeline + docked panel | `Timeline.dc.html` | 1440×1080 | `/sessions/:id/timeline` | W5 |
| Detail panel (detached tab) | `DetailPanel.dc.html` | 720×2200 | `/sessions/:id/panel` | W4 |

**How to read an artboard file**

- The markup lives inside `<x-dc>`; the `{{name}}` insertions are filled from `renderVals()` in the `<script type="text/x-dc">` block at the end of the file. The mockup's sample data is there too: it shows which fields the screen needs.
- Lines 13–15 of each file are Carbon tokens, several kilobytes per line. The substantive part starts after them: read from line 16.
- `<x-import component-from-global-scope="Carbon.Name">` is a place where the mockup uses a Carbon component. In torch a component from `@carbon/react` stands in its place.
- `sc-for` is a repeat over a list, `sc-if` is a condition, `dc-import` is a nested artboard (the panel inside the timeline).
- The script's `data-props` properties are mockup switches (the dashboard range, the dock position), not data.

**The canvas design system:** Carbon, installed in the artifact under `project/ds/carbon/` (`README.md`, `tokens.json`, `components/bundle.css`, `components/bundle.js`). Not copied into the repository: torch takes tokens and components from the Carbon packages.

**Colors from the mockup** (Carbon tokens; needed for chart series and timeline marks)

| Purpose | Token | Value |
|---|---|---|
| Input; Model calls chart; model call mark | `purple-60` | `#8a3ffc` |
| Output; external request | `cyan-40` | `#33b1ff` |
| Cache read; Tool calls chart; bars in tables | `blue-60` | `#0f62fe` |
| Cache write; tool call mark; Tool usage in the panel | `teal-50` | `#009d9a` |
| Error (any mark) | `support-error` | `#da1e28` |
| Agent launch: fill / border | `blue-20` / `blue-60` | `#d0e2ff` / `#0f62fe` |
| Prompt (diamond); session bar | `gray-100`; `gray-80` | `#161616`; `#393939` |
| File read (outline) / file edit (fill) | `blue-60` | `#0f62fe` |
| Context: First / Last / Peak | `blue-40` / `blue-60` / `blue-80` | `#78a9ff` / `#0f62fe` / `#002d9c` |
| Context at the peak, categories in order | `gray-50`, `purple-60`, `cyan-40`, `blue-60`, `teal-50` | `#8d8d8d`, … |

Fonts: IBM Plex Sans and IBM Plex Mono. The header uses the `g100` theme, the rest is light.

---

## 3. Data on the machine

The structure and fields are described in plan.md §3. Only addresses are given here.

| What | Where |
|---|---|
| Session transcripts | `~/.claude/projects/<cwd-with-hyphens>/<sessionId>.jsonl` |
| Subagent transcripts and metadata | `~/.claude/projects/<…>/<sessionId>/subagents/agent-<agentId>.jsonl`, `.meta.json` |
| Manually set session name | `~/.claude/projects/<…>/<sessionId>/custom-title.json` |
| Large tool outputs | `~/.claude/projects/<…>/<sessionId>/tool-results/` |
| Desktop app session metadata | `~/Library/Application Support/Claude/claude-code-sessions/<uuid>/<uuid>/local_<uuid>.json` |
| Claude Code settings | `~/.claude/settings.json` |
| History of entered prompts | `~/.claude/history.jsonl` |
| Model catalog (no prices) | `~/.claude/cache/model-catalog/` |
| torch data (will appear) | `~/.torch/` |

Volume as of 2026-11-09: 854 project directories, 1001 main sessions, 230 subagent files, 510 MB, the oldest file from 2026-08-06.

---

## 4. Claude Code documentation

The addresses were obtained during design on 2026-11-09. The documentation changes: open the page again before relying on it.

| Topic | Page |
|---|---|
| Hooks: events and fields | `https://code.claude.com/docs/en/hooks.md`, `https://code.claude.com/docs/en/hooks-guide.md` |
| Settings, `cleanupPeriodDays`, the `env` block | `https://code.claude.com/docs/en/settings-reference.md` |
| OpenTelemetry: metrics, events, variables | `https://code.claude.com/docs/en/monitoring-usage.md` |
| Transcripts: location, format status | `https://code.claude.com/docs/en/sessions.md` |
| The `~/.claude` directory, automatic cleanup | `https://code.claude.com/docs/en/claude-directory.md` |
| Status line: the `context_window`, `cost` fields | `https://code.claude.com/docs/en/statusline.md` |
| Agent SDK: `getContextUsage`, session list | `https://code.claude.com/docs/en/agent-sdk/typescript.md`, `https://code.claude.com/docs/en/agent-sdk/python.md` |
| Environment variables | `https://code.claude.com/docs/en/env-vars.md` |
| Errors and retries | `https://code.claude.com/docs/en/errors.md` |
| Gateway in front of the API (second wave) | `https://code.claude.com/docs/en/llm-gateway.md`, `…/llm-gateway-protocol.md`, `…/llm-gateway-connect.md` |
| Network, proxy, certificates | `https://code.claude.com/docs/en/network-config.md` |
| Feature availability by provider | `https://code.claude.com/docs/en/feature-availability.md` |
| Cloud sessions, Remote Control (outside the first wave) | `https://code.claude.com/docs/en/claude-code-on-the-web.md`, `https://code.claude.com/docs/en/remote-control.md` |

Model prices: the Anthropic documentation on the day package P2 is executed; the environment has the `claude-api` skill with a reference on models and prices.

---

## 5. Carbon

- **Components:** the `@carbon/react` package.
- **Charts:** Carbon Charts for React. Confirmed components: `SimpleBarChart`, `StackedBarChart`, `GroupedBarChart`, `MeterChart` (it has a proportional mode).
- **The Carbon Design System reference server** is connected to the environment as an MCP. Three tools, each with its own area:

  | Tool | What for |
  |---|---|
  | `get_charts` | Everything about Carbon Charts: first `mode: "schema"`, then `mode: "full"` with the chosen variant. The response includes the install command and the style import line — use them verbatim. |
  | `code_search` | Examples, variants and properties of components, icons. Specify `component_type: "React"`. |
  | `docs_search` | Usage rules, accessibility, style. |

  Tool names in the environment start with `mcp__<server identifier>__`; they can be found by searching for tools by the word `get_charts`.

---

## 6. Environment

| Tool | Version as of 2026-11-09 |
|---|---|
| macOS | Darwin 25.4.0 |
| bun | 1.3.11 |
| node | 25.9.0 |
| npm | 11.12.1 |
| sqlite3 | 3.51.0 |
| python3 | 3.9.6 (system) |
| uv | 0.11.12 |
| claude (in PATH) | 2.1.288 |
| Claude Code inside the desktop app | 2.1.321 |
| pnpm, duckdb | not installed |

Claude Code versions 2.1.221, 2.1.226, 2.1.237, 2.1.260 and newer occur in transcripts.

---

## 7. Agent tools

| Task | With what |
|---|---|
| Launching a worker | The Agent tool with `isolation: "worktree"`; a brief per the packages.md §3 template |
| Independent review | A fresh Agent: gets the package brief and the diff, without the worker's report |
| The core via tests | The skill `mattpocock-skills:tdd` |
| A brief, `CLAUDE.md`, any text for an agent | The skill `mattpocock-skills:writing-for-agents` |
| Screen check | The built-in browser: launch via `.claude/launch.json`, a page snapshot, comparison with the artboard |
| Questions about Claude Code (hooks, OTel, settings) | The `claude-code-guide` agent |

---

## 8. Findings that are not in the plan

Not needed by the first wave, but they were expensive to find.

- **The desktop app and proxies.** The Code tab in the desktop app does not read `ANTHROPIC_BASE_URL` and the `env` block to choose the API address: it has a separate third-party provider setting. At the same time the `CLAUDE_CODE_ENABLE_TELEMETRY` variable from `settings.json` is visible inside a desktop session.
- **Gateway and subscription.** `ANTHROPIC_BASE_URL` pointing to a pass-through gateway keeps subscription sign-in. The gateway must pass `anthropic-version`, `anthropic-beta`, the `cache_control` fields and error bodies through unchanged. Behind a gateway, Remote Control and server-managed settings are disabled.
- **Headers for request correlation.** `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`, `x-claude-code-agent-type`, `x-claude-code-request-class`, `x-claude-code-prompt-id`. On a non-standard API address they are enabled by the `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` variable.
- **Context breakdown for a live session.** Agent SDK: `Query.getContextUsage()` in TypeScript, `ClaudeSDKClient.get_context_usage()` in Python. Works only for a session started via the SDK; there is no way for past sessions.
- **The status line** receives `context_window` (window size, percent used, tokens of the last call) and `cost` on every model response, but stores them nowhere.
- **Time to first token** arrives in logs: the `ttft_ms` attribute of the `api_request` event (spikes.md §8). OTel traces (beta) give the same: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_TRACES_EXPORTER=otlp`.
- **Cloud sessions.** There is no export and no list API. Teleport (`claude --teleport`) requires a clean checkout of the same repository and does not carry over messages that were dropped during compaction.
- **The `api-request`, `api-request-shape`, `api-request-blob` lines** in transcripts store request parameters, and in rare cases (16 lines across the whole history) the full system prompt and tool descriptions.
- **`cost-state`** is a ready total per session with a breakdown by model; it exists in only 34 lines.
- **`plan-usage-history.json`** in the desktop app directory holds samples of subscription limit usage.

---

## 9. What is not verified

- Seven experimental checks: plan.md §10.1.
- How Claude Code is signed in on this machine (subscription or key): a command from the agent environment showed "not authorized", which does not reflect the desktop app.
- A proportional `MeterChart` with four segments with labels: not run. The fallback is `StackedBarChart` with one row, the replacement only inside the `ProportionChart` organism.
- Which gateway stands on the target system and where its logs are: the owner did not say, needed for the second wave.
