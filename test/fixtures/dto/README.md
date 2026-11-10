# API responses for the screens

The files are created by `bun run fixtures` from the reference session (`test/support/reference*.ts`); they are not edited by hand. Types are in `src/contracts/api.ts`.

The reference session is the scenario of the mockup "Migrate billing API client to openapi-ts": 5 agents, 142 model calls, 186 tool calls, 7 tool errors, 3 API errors, 3 prompts. Its identifier is `8f3c1a2e-61b0-4c7e-9d2a-000000000142`. The other 15 sessions of the mockup exist only in the list and the dashboard.

| Route | File | Key |
|---|---|---|
| `GET /api/sessions` | `sessions.json` | — |
| `GET /api/projects` | `projects.json` | — |
| `GET /api/sessions/:id` | `session.json`; `sessionRunning.json` — the same session as a running one, with partial enrichment and without cost | — |
| `GET /api/sessions/:id/export` | `sessionExport.json` | — |
| `GET /api/sessions/:id/timeline` | `timeline.json` | — |
| `GET /api/sessions/:id/agents/:agentId` | `agents.json` | `agentId` |
| `GET /api/sessions/:id/tool-calls/:callId` | `toolCalls.json` | call identifier |
| `GET /api/sessions/:id/prompts/:promptId` | `prompts.json` | prompt identifier |
| `GET /api/sessions/:id/files?path=` | `files.json` | file path |
| `GET /api/sessions/:id/network/:kind/:netId` | `network.json` | `<kind>:<netId>` |
| `GET /api/contents/:id` | `contents.json` | body identifier |
| `GET /api/dashboard?range=` | `dashboard.<range>.json` | — |
| `GET /api/settings` | `settings.json` | — |

Times in the examples are in UTC: the reference session starts at 2026-10-31 14:02:11 UTC, the dashboard's "today" is 2026-10-31. The tokens and cost of the reference session are derived from its calls and differ from the numbers in the mockup.
