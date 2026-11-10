// SSE events, GET /api/events (plan §8). Each event is a `data:` line with JSON of this type.

export type ServerEvent =
  /** A session's data changed: the open overview and timeline re-read it. */
  | { type: "session_changed"; sessionId: string }
  /** An indexer pass finished: lists and the dashboard re-read the data. */
  | { type: "index_updated"; sessions: number };

export type ServerEventType = ServerEvent["type"];
