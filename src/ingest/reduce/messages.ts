// Model text and thinking. Package I2.
import { SYNTHETIC_MODEL } from "../../contracts/constants.ts";
import type { AssistantBlock } from "../../contracts/lines.ts";
import type { LineReducer } from "../../contracts/pipeline.ts";
import type { MessageKind } from "../../contracts/rows.ts";
import { putContent } from "./contents.ts";

function messageOf(block: AssistantBlock): { kind: MessageKind; body: string } | null {
  if (block.type === "text") return { kind: "text", body: block.text };
  if (block.type === "thinking") return { kind: "thinking", body: block.thinking };
  return null;
}

export const reduceMessages: LineReducer = (ctx, lines) => {
  const upsert = ctx.db.query<null, [string, string, string, string | null, number, MessageKind, number]>(
    `INSERT INTO messages (session_id, id, agent_id, model_call_id, ts, kind, content_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, id) DO UPDATE SET
       agent_id = excluded.agent_id,
       model_call_id = excluded.model_call_id,
       ts = excluded.ts,
       kind = excluded.kind,
       content_id = excluded.content_id`,
  );
  for (const line of lines) {
    if (line.kind !== "assistant" || line.uuid === null || line.timestamp === null) continue;
    // The row with the <synthetic> model was added by Claude Code: it is neither a model reply nor an API call.
    if (line.isApiErrorMessage || line.model === SYNTHETIC_MODEL) continue;
    const callId = ctx.provider.callKey(line);
    for (const [index, block] of line.blocks.entries()) {
      const message = messageOf(block);
      // There is nothing to show for an empty block (thinking without text, a line break before a tool call).
      if (message === null || message.body.trim() === "") continue;
      upsert.run(ctx.sessionId, `${line.uuid}:${index}`, ctx.agentId, callId, line.timestamp, message.kind, putContent(ctx.db, message.body));
    }
  }
};
