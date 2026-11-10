-- The enrichment merge looks up a session's hooks events by name and time (enrich/merge.ts):
-- without an index the query scanned the events of all sessions.
CREATE INDEX hook_events_session ON hook_events (session_id, name, ts);
