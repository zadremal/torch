-- Decision 12 revised: a tool call blocked by a permission rule, auto mode, a hook or another app is an
-- error; only a call the user rejected stays denied (reduce/toolCalls.ts). Indexed rows are reclassified here.
--
-- The transcript's `toolDenialKind` is not stored, so an indexed denial is the user's rejection when its
-- permission source is the user's or its output is Claude Code's rejection message. An output stored
-- compressed (over 4 KB) is left denied: blocking messages are short, only a rejection with the user's long
-- reply is that large.

UPDATE tool_calls SET permission_decision = 'reject' WHERE status = 'denied' AND permission_decision IS NULL;

UPDATE tool_calls SET
  status = 'error',
  error_title = COALESCE(
    error_title,
    (SELECT NULLIF(trim(substr(text, 1, instr(text || char(10), char(10)) - 1)), '')
     FROM (SELECT trim(CAST(body AS TEXT)) AS text FROM contents WHERE id = tool_calls.output_content_id))
  )
WHERE status = 'denied'
  AND COALESCE(permission_source, '') NOT LIKE 'user%'
  AND EXISTS (
    SELECT 1 FROM contents c
    WHERE c.id = tool_calls.output_content_id
      AND c.encoding = 'raw'
      AND CAST(c.body AS TEXT) NOT LIKE 'The user doesn''t want to proceed%'
  );

-- Totals as in reduce/totals.ts: agents from their calls, sessions as the sum over their agents.
UPDATE agents SET tool_errors = (
  SELECT COUNT(*) FROM tool_calls t
  WHERE t.session_id = agents.session_id AND t.agent_id = agents.agent_id AND t.status = 'error'
);

UPDATE sessions SET tool_errors = (SELECT COALESCE(SUM(tool_errors), 0) FROM agents WHERE agents.session_id = sessions.id);
