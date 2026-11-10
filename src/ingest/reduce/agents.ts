// Session agents and their link to the parent model call. Package I2.
import { MAIN_AGENT_ID } from "../../contracts/constants.ts";
import type { DerivedReducer, LineReducer } from "../../contracts/pipeline.ts";
import type { AgentRow, ToolCallRow } from "../../contracts/rows.ts";
import { putContent } from "./contents.ts";
import { isPrompt, promptText } from "./prompts.ts";
import { timeBounds } from "./session.ts";

/** Depth of a subagent about which nothing is known: it was launched by at least the main agent. */
const DEFAULT_SUBAGENT_DEPTH = 1;

export const reduceAgents: LineReducer = (ctx, lines) => {
  const meta = ctx.agentMeta;
  const [startedAt, endedAt] = timeBounds(lines);
  // First prompt of the file: for the main agent it is the user's message, for a subagent the task from its parent.
  // The body is stored once: prompts of later passes do not change the agent's task and do not go into contents.
  const known = ctx.db
    .query<{ prompt_content_id: number | null }, [string, string]>("SELECT prompt_content_id FROM agents WHERE session_id = ? AND agent_id = ?")
    .get(ctx.sessionId, ctx.agentId);
  const prompt = known?.prompt_content_id == null ? lines.find(isPrompt) : undefined;

  ctx.db
    .query(
      `INSERT INTO agents (session_id, agent_id, parent_agent_id, depth, spawn_tool_call_id, type, description, started_at, ended_at, prompt_content_id)
       VALUES (?1, ?2, ?3, COALESCE(?4, ?5), ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (session_id, agent_id) DO UPDATE SET
         parent_agent_id = COALESCE(excluded.parent_agent_id, parent_agent_id),
         depth = COALESCE(?4, depth),
         spawn_tool_call_id = COALESCE(excluded.spawn_tool_call_id, spawn_tool_call_id),
         type = COALESCE(excluded.type, type),
         description = COALESCE(excluded.description, description),
         started_at = MIN(COALESCE(started_at, excluded.started_at), COALESCE(excluded.started_at, started_at)),
         ended_at = MAX(COALESCE(ended_at, excluded.ended_at), COALESCE(excluded.ended_at, ended_at)),
         prompt_content_id = COALESCE(prompt_content_id, excluded.prompt_content_id)`,
    )
    .run(
      ctx.sessionId,
      ctx.agentId,
      meta?.parentAgentId ?? null,
      meta?.spawnDepth ?? null,
      ctx.agentId === MAIN_AGENT_ID ? 0 : DEFAULT_SUBAGENT_DEPTH,
      meta?.toolUseId ?? null,
      meta?.agentType ?? null,
      meta?.description ?? null,
      startedAt,
      endedAt,
      prompt ? putContent(ctx.db, promptText(prompt)) : null,
    );
};

/** Sets the parent and depth of subagents once the files of both the parent and the descendant are loaded. */
export const linkAgents: DerivedReducer = ({ db, sessionId }) => {
  const subagents = db
    .query<Pick<AgentRow, "agent_id" | "spawn_tool_call_id">, [string, string]>(
      "SELECT agent_id, spawn_tool_call_id FROM agents WHERE session_id = ? AND agent_id != ?",
    )
    .all(sessionId, MAIN_AGENT_ID);

  type SpawnCall = Pick<ToolCallRow, "id" | "agent_id">;
  // The Agent call that launched the subagent: `toolUseId` from meta.json is the call identifier…
  const callById = db.query<SpawnCall, [string, string]>("SELECT id, agent_id FROM tool_calls WHERE session_id = ? AND id = ?");
  // …and `agentId` from the call result is the subagent's file name.
  const callBySpawned = db.query<SpawnCall, [string, string]>(
    "SELECT id, agent_id FROM tool_calls WHERE session_id = ? AND spawned_agent_id = ? ORDER BY ts_start, id LIMIT 1",
  );
  const link = db.query("UPDATE agents SET parent_agent_id = ?, spawn_tool_call_id = ? WHERE session_id = ? AND agent_id = ?");

  for (const agent of subagents) {
    const call =
      (agent.spawn_tool_call_id === null ? null : callById.get(sessionId, agent.spawn_tool_call_id)) ??
      callBySpawned.get(sessionId, agent.agent_id);
    // The parent is the agent that made the call. Until the parent's file is loaded, the call is not in the database.
    if (call && call.agent_id !== agent.agent_id) link.run(call.agent_id, call.id, sessionId, agent.agent_id);
  }

  // Depth is the distance to the main agent along the chain of parents. An agent whose chain to the main one
  // is not yet assembled keeps the depth from meta.json.
  db.query(
    `WITH RECURSIVE tree (agent_id, depth) AS (
       SELECT agent_id, 0 FROM agents WHERE session_id = ?1 AND agent_id = ?2
       UNION ALL
       SELECT child.agent_id, tree.depth + 1
       FROM agents AS child JOIN tree ON child.parent_agent_id = tree.agent_id
       WHERE child.session_id = ?1 AND child.agent_id != ?2
     )
     UPDATE agents SET depth = tree.depth FROM tree WHERE agents.session_id = ?1 AND agents.agent_id = tree.agent_id`,
  ).run(sessionId, MAIN_AGENT_ID);
};
