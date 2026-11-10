// User messages: original and follow_up. Package I2.
import { MAIN_AGENT_ID, NON_PROMPT_ORIGINS, NON_PROMPT_TEXT_PREFIXES, estimateTokens } from "../../contracts/constants.ts";
import type { ParsedLine, UserLine } from "../../contracts/lines.ts";
import type { LineReducer } from "../../contracts/pipeline.ts";
import { putContent } from "./contents.ts";

export type PromptLine = UserLine & { uuid: string; timestamp: number };

/**
 * A prompt is a `user` row with text or an image that carries no tool result and is not
 * marked as internal: not `isMeta`, not a compacted-context summary, not a background task notification
 * and not a Claude Code record of command output or an interruption (spikes.md §2). A message from another session
 * (`peer`) is a prompt: for this session it is a task.
 * In the main file a prompt is the user's message, in a subagent file the task from its parent.
 */
export function isPrompt(line: ParsedLine): line is PromptLine {
  return (
    line.kind === "user" &&
    !line.isMeta &&
    !line.isCompactSummary &&
    !(line.originKind !== null && NON_PROMPT_ORIGINS.includes(line.originKind)) &&
    line.toolResults.length === 0 &&
    (line.text !== null || line.images > 0) &&
    !NON_PROMPT_TEXT_PREFIXES.some((prefix) => line.text?.trimStart().startsWith(prefix)) &&
    line.uuid !== null &&
    line.timestamp !== null
  );
}

const COMMAND_START = /^\s*<command-(?:name|message)>/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Prompt text as the user entered it. A command call is recorded with the tags `command-message`,
 * `command-name`, `command-args`: what remains of it is "/name arguments".
 */
export function promptText(line: PromptLine): string {
  const text = line.text ?? "";
  if (!COMMAND_START.test(text)) return text;
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!name) return text;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** Pasted images have no names in the transcript: they are numbered as in the Claude Code interface. */
function attachmentNames(images: number): string | null {
  if (images === 0) return null;
  return JSON.stringify(Array.from({ length: images }, (_, index) => `Image #${index + 1}`));
}

export const reducePrompts: LineReducer = (ctx, lines) => {
  // A subagent's task is not a user message: it is stored on the agent (agents.prompt_content_id).
  if (ctx.agentId !== MAIN_AGENT_ID) return;

  // The number of a new prompt is the count already recorded: the first in the session gets 0 and kind original.
  // A row that arrives again keeps its existing number and kind.
  const insert = ctx.db.query<null, [string, string, number, number, number, string | null]>(
    `INSERT INTO prompts (session_id, id, ts, seq, kind, content_id, tokens_est, attachments_json)
     SELECT ?1, ?2, ?3, COUNT(*), CASE COUNT(*) WHEN 0 THEN 'original' ELSE 'follow_up' END, ?4, ?5, ?6
     FROM prompts
     WHERE session_id = ?1
     ON CONFLICT (session_id, id) DO NOTHING`,
  );
  for (const line of lines.filter(isPrompt)) {
    const text = promptText(line);
    insert.run(
      ctx.sessionId,
      line.uuid,
      line.timestamp,
      putContent(ctx.db, text),
      estimateTokens(Buffer.byteLength(text, "utf8")),
      attachmentNames(line.images),
    );
  }
};
