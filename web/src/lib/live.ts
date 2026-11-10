// SSE /api/events subscription with recovery after a dropped connection. Package L1.
// There is one connection per tab and it is held only by a visible one: the browser allows six connections per
// server address, and panels opened in separate tabs would otherwise take them all.
import type { ServerEvent } from "@contracts/events.ts";
import { useEffect, useMemo } from "react";
import { apiPath, isFixtureMode } from "./api.ts";
import type { ApiState } from "./useApi.ts";

/** How long after a drop the connection is reopened. */
export const RECONNECT_MS = 2000;

/** Handlers of a single connection. */
export interface LiveHandlers {
  onOpen: () => void;
  /** The `data` field of one event. */
  onMessage: (data: string) => void;
  onError: () => void;
}

/** What the subscription needs from the browser; replaced in tests. */
export interface LiveEnv {
  /** Opens a connection to the event stream; returns a close function. */
  open: (handlers: LiveHandlers) => () => void;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => void;
}

interface Subscriber {
  onEvent: (event: ServerEvent) => void;
  onResync: () => void;
}

/**
 * Subscription to server events over a single connection. `subscribe` returns an unsubscribe function.
 * `onResync` is called when the connection opened after a gap, a drop or a hidden tab:
 * events in the meantime are lost, so the subscriber rereads its data in full.
 */
export function createLive(env: LiveEnv) {
  const subscribers = new Set<Subscriber>();
  let close: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchingVisibility = false;
  /** The connection dropped while subscribers were alive: the next open is a reason to reread. */
  let missed = false;

  const disconnect = (): void => {
    close?.();
    close = null;
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };

  const connect = (): void => {
    close = env.open({
      onOpen: () => {
        if (!missed) return;
        missed = false;
        for (const subscriber of [...subscribers]) subscriber.onResync();
      },
      onMessage: (data) => {
        const event = JSON.parse(data) as ServerEvent;
        for (const subscriber of [...subscribers]) subscriber.onEvent(event);
      },
      onError: () => {
        // The browser reconnects by itself only after a network drop, and after an error response (the server
        // is restarting, the proxy answers 502) it gives up: the connection is reopened here.
        disconnect();
        missed = true;
        retry = setTimeout(connect, RECONNECT_MS);
      },
    });
  };

  /** A connection exists exactly when there are subscribers and the tab is visible. */
  const sync = (): void => {
    const wanted = subscribers.size > 0 && env.isVisible();
    const active = close !== null || retry !== null;
    if (wanted && !active) connect();
    if (!wanted && active) {
      disconnect();
      missed = subscribers.size > 0;
    }
  };

  return {
    subscribe(onEvent: (event: ServerEvent) => void, onResync: () => void = () => {}): () => void {
      const subscriber: Subscriber = { onEvent, onResync };
      subscribers.add(subscriber);
      if (!watchingVisibility) {
        watchingVisibility = true;
        env.onVisibilityChange(sync);
      }
      sync();
      return () => {
        subscribers.delete(subscriber);
        // The page changed: the old one unsubscribes and the new one subscribes in a row, the connection stays.
        queueMicrotask(sync);
      };
    },
  };
}

// This module is also checked by the root tsconfig, together with its test, without DOM types:
// the little the subscription needs from the browser is described in place.
declare const document: { visibilityState: string; addEventListener(type: "visibilitychange", listener: () => void): void };
declare const EventSource: new (url: string) => {
  onopen: (() => void) | null;
  onmessage: ((message: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
};

const browser: LiveEnv = {
  open({ onOpen, onMessage, onError }) {
    const source = new EventSource(apiPath("events"));
    source.onopen = onOpen;
    source.onmessage = (message) => onMessage(message.data);
    source.onerror = onError;
    return () => source.close();
  },
  isVisible: () => document.visibilityState === "visible",
  onVisibilityChange: (listener) => document.addEventListener("visibilitychange", listener),
};

const live = createLive(browser);

/** Subscribes handlers to server events; returns an unsubscribe function. In fixture mode there is no server. */
export function subscribe(onEvent: (event: ServerEvent) => void, onResync?: () => void): () => void {
  return isFixtureMode() ? () => {} : live.subscribe(onEvent, onResync);
}

/** Whether the event concerns the page data: with `sessionId`, that session; without it, the lists and the dashboard. */
export function concerns(event: ServerEvent, sessionId?: string): boolean {
  return sessionId === undefined ? event.type === "index_updated" : event.type === "session_changed" && event.sessionId === sessionId;
}

/**
 * Rereading without overlapping requests. While a request is in flight, changes accumulate into one next request:
 * a running session is written to more often than a response can arrive, and a request cancelled by a new one would never complete.
 */
export function reloadQueue(reload: () => void) {
  let loading = false;
  let pending = false;
  return {
    /** Data on the server changed. */
    changed(): void {
      if (loading) pending = true;
      else reload();
    },
    /** The page request started or finished. */
    setLoading(now: boolean): void {
      loading = now;
      if (loading || !pending) return;
      pending = false;
      reload();
    },
  };
}

/**
 * Live update of the page data (plan §9.4: the subscription lives only in pages). Rereads
 * `useApi` with the same request: the data stays on screen, the selection, scroll and address do not change.
 * With `sessionId`, on a change of that session; without it, on a completed indexer pass.
 * Example: `useLiveReload(timeline, id)`.
 */
export function useLiveReload({ loading, reload }: Pick<ApiState<unknown>, "loading" | "reload">, sessionId?: string): void {
  const queue = useMemo(() => reloadQueue(reload), [reload]);
  useEffect(() => queue.setLoading(loading), [queue, loading]);
  useEffect(
    () =>
      subscribe((event) => {
        if (concerns(event, sessionId)) queue.changed();
      }, queue.changed),
    [queue, sessionId],
  );
}
