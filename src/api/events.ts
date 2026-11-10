// SSE event stream (plan §8). Package L1.
// Subscribers are the open GET /api/events connections of this process: an event goes to all of them at once.
import type { ServerEvent } from "../contracts/events.ts";
import type { Handler } from "./context.ts";

/**
 * Connection heartbeat. Without events the stream is silent, and Bun closes the connection after 10 seconds
 * of idleness: an SSE comment keeps it open and the browser does not see it as an event.
 */
export const SSE_HEARTBEAT_MS = 5000;

const listeners = new Set<(event: ServerEvent) => void>();

function publish(event: ServerEvent): void {
  for (const listener of [...listeners]) listener(event);
}

/** Events of a finished indexer pass: one per changed session and one common to the lists. */
export function publishIndexed(sessionIds: string[]): void {
  for (const sessionId of sessionIds) publish({ type: "session_changed", sessionId });
  publish({ type: "index_updated", sessions: sessionIds.length });
}

export const streamEvents: Handler = () => {
  const encoder = new TextEncoder();
  let close = (): void => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The stream is already closed on that side: the subscriber is removed so the event is not written into the void.
          close();
        }
      };
      const listener = (event: ServerEvent): void => send(`data: ${JSON.stringify(event)}\n\n`);
      const heartbeat = setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS);
      close = () => {
        clearInterval(heartbeat);
        listeners.delete(listener);
      };
      listeners.add(listener);
      // The first write sends the headers: the browser considers the connection open without waiting for an event.
      send(": connected\n\n");
    },
    // The client left: Bun cancels the response stream.
    cancel() {
      close();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
};
