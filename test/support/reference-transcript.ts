// The reference session as Claude Code transcripts: the main file and four subagent files.
// Line times are chosen so that duration estimates by the rules of plan §6.2 give the scenario's
// values: response lines sit at the end of the model call, a tool result at its end.

import { MAIN_AGENT_ID } from "../../src/contracts/constants.ts";
import { referenceScenario, type RefAgent, type RefScenario, type RefToolCall } from "./reference.ts";
import { text, thinking, toolUse, transcript, writeSession, type SessionFiles, type Transcript, type WrittenSession } from "./transcript.ts";

function toolUseResult(scn: RefScenario, tool: RefToolCall): unknown {
  // For errors Claude Code writes a string into toolUseResult.
  if (tool.status === "error") return `Error: ${tool.errorTitle}`;
  const durationMs = tool.tsEnd - tool.tsStart;
  switch (tool.name) {
    case "Read":
      return { type: "text", file: { filePath: tool.file!.path, content: "", numLines: 214, startLine: 1, totalLines: 214 } };
    case "Edit":
      return {
        filePath: tool.file!.path,
        oldString: tool.input.old_string,
        newString: tool.input.new_string,
        originalFile: "",
        replaceAll: false,
        userModified: false,
        structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 6, lines: [...Array.from({ length: 3 }, () => "-old"), ...Array.from({ length: 6 }, () => "+new")] }],
      };
    case "Write":
      return { type: "create", filePath: tool.file!.path, content: tool.input.content, originalFile: null, structuredPatch: [], userModified: false };
    case "Bash":
      return { stdout: tool.output, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
    case "Grep":
      return { mode: "files_with_matches", filenames: [], numFiles: 7 };
    case "Glob":
      return { filenames: [], numFiles: 23, durationMs, truncated: false };
    case "WebFetch":
      return { url: tool.webFetch!.url, code: tool.webFetch!.code, codeText: "OK", bytes: tool.webFetch!.bytes, durationMs, result: tool.output };
    case "Agent": {
      const sub = scn.agents.find((a) => a.id === tool.spawnedAgentId)!;
      return sub.sync
        ? { agentId: sub.id, agentType: sub.type, status: "completed", prompt: sub.prompt, content: [{ type: "text", text: tool.output }], totalDurationMs: durationMs, totalTokens: 0, totalToolUseCount: 0 }
        : { agentId: sub.id, isAsync: true, status: "async_launched", description: sub.description, prompt: sub.prompt, canReadOutputFile: true, outputFile: `/tmp/${sub.id}.output` };
    }
    default:
      return { oldTodos: [], newTodos: tool.input.todos };
  }
}

function agentTranscript(scn: RefScenario, agent: RefAgent): Transcript {
  const isMain = agent.id === MAIN_AGENT_ID;
  const t = transcript({ sessionId: scn.sessionId, agentId: isMain ? undefined : agent.id, cwd: scn.cwd, startAt: agent.start });

  type Event = { ts: number; order: number; emit: () => void };
  const events: Event[] = [];
  const add = (ts: number, order: number, emit: () => void) => events.push({ ts, order, emit });

  if (isMain) {
    for (const prompt of scn.prompts) add(prompt.ts, 0, () => t.prompt(prompt.text, { at: prompt.ts, uuid: prompt.id, images: prompt.attachments.length }));
  } else {
    add(agent.start, 0, () => t.prompt(agent.prompt, { at: agent.start }));
  }
  add(agent.start, 1, () =>
    t.instructions(
      agent.instructions.map((file) => ({ path: file.path, type: file.memoryType, content: "x".repeat(file.bytes) })),
      { at: agent.start, uuid: `ref-instr-${agent.id}` },
    ),
  );
  for (const error of scn.apiErrors.filter((e) => e.agentId === agent.id)) {
    add(error.ts, 2, () => t.apiError({ message: error.error, retryAttempt: error.attempt, maxRetries: error.maxRetries, retryInMs: error.retryInMs, at: error.ts, uuid: error.id }));
  }
  for (const call of scn.modelCalls.filter((c) => c.agentId === agent.id)) {
    const tools = call.toolCallIds.map((id) => scn.toolCalls.find((tool) => tool.id === id)!);
    const blocks = [...(call.thinking ? [thinking(call.thinking)] : []), text(call.text), ...tools.map((tool) => toolUse(tool.name, tool.input, tool.id))];
    add(call.tsEnd, 3, () =>
      t.assistant({
        requestId: call.id,
        model: call.model,
        at: call.tsEnd,
        stopReason: call.stopReason,
        blocks,
        uuids: blocks.map((_, index) => `${call.id}/${index}`),
        usage: {
          input: call.tokInput,
          output: call.tokOutput,
          cacheRead: call.tokCacheRead,
          cacheWrite5m: call.tokCacheWrite5m,
          cacheWrite1h: call.tokCacheWrite1h,
          ...(call.tokThinking > 0 ? { thinking: call.tokThinking } : {}),
        },
      }),
    );
    for (const tool of tools) {
      add(tool.tsEnd, 4, () => t.toolResult(tool.id, { content: tool.output, isError: tool.status === "error", toolUseResult: toolUseResult(scn, tool), at: tool.tsEnd }));
    }
  }

  // Stable sort: at equal times the order is set by the event kind, then by the order of addition.
  events.sort((a, b) => a.ts - b.ts || a.order - b.order);
  for (const event of events) event.emit();
  if (isMain) t.aiTitle(scn.name);
  return t;
}

/** Files of the reference session: the main transcript, subagents and their meta.json. */
export function referenceFiles(scn: RefScenario = referenceScenario()): SessionFiles {
  const [main, ...subs] = scn.agents;
  return {
    main: agentTranscript(scn, main!),
    subagents: subs.map((agent) => ({
      transcript: agentTranscript(scn, agent),
      meta: { agentType: agent.type, description: agent.description, toolUseId: agent.spawnToolCallId, spawnDepth: agent.depth },
    })),
  };
}

/** Writes the reference session under the transcripts root. */
export function writeReferenceSession(transcriptsRoot: string, scn: RefScenario = referenceScenario()): WrittenSession {
  return writeSession(transcriptsRoot, referenceFiles(scn));
}
