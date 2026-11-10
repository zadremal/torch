// Subscription to server events: one connection per tab, recovery after a drop, a hidden
// tab, event filtering for a page and rereading without overlapping requests. There is no browser in the
// tests: the connection and tab visibility are replaced, the `useLiveReload` hook is checked in the browser.
import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ServerEvent } from "../../src/contracts/events.ts";
import { concerns, createLive, type LiveHandlers, RECONNECT_MS, reloadQueue, subscribe } from "../../web/src/lib/live.ts";

afterEach(() => {
  jest.useRealTimers();
});

/** A fake browser: remembers open connections and tab visibility. */
function fakeBrowser() {
  const connections: { handlers: LiveHandlers; closed: boolean }[] = [];
  const state = { visible: true };
  let visibilityListener = (): void => {};
  let visibilityListeners = 0;
  const live = createLive({
    open(handlers) {
      const connection = { handlers, closed: false };
      connections.push(connection);
      return () => {
        connection.closed = true;
      };
    },
    isVisible: () => state.visible,
    onVisibilityChange(listener) {
      visibilityListener = listener;
      visibilityListeners += 1;
    },
  });
  return {
    live,
    connections,
    /** Connections that are open right now. */
    opened: () => connections.filter((connection) => !connection.closed),
    last: () => connections.at(-1)!.handlers,
    send: (event: ServerEvent) => connections.at(-1)!.handlers.onMessage(JSON.stringify(event)),
    setVisible(visible: boolean) {
      state.visible = visible;
      visibilityListener();
    },
    visibilityListeners: () => visibilityListeners,
  };
}

/** A subscriber that records everything it received. */
function recorder(live: ReturnType<typeof createLive>) {
  const events: ServerEvent[] = [];
  const state = { resyncs: 0 };
  const unsubscribe = live.subscribe(
    (event) => events.push(event),
    () => void state.resyncs++,
  );
  return { events, state, unsubscribe };
}

/** Unsubscribing closes the connection after the current task. */
const settle = (): Promise<void> => Promise.resolve();

const CHANGED: ServerEvent = { type: "session_changed", sessionId: "s1" };
const INDEXED: ServerEvent = { type: "index_updated", sessions: 1 };

describe("connection", () => {
  test("the first subscription opens a connection, the rest use the same one", () => {
    const b = fakeBrowser();
    expect(b.connections).toHaveLength(0);

    const first = recorder(b.live);
    const second = recorder(b.live);
    b.last().onOpen();
    b.send(CHANGED);
    b.send(INDEXED);

    expect(b.connections).toHaveLength(1);
    expect(first.events).toEqual([CHANGED, INDEXED]);
    expect(second.events).toEqual([CHANGED, INDEXED]);
    // The first open is not a recovery: the page has just loaded the data itself.
    expect([first.state.resyncs, second.state.resyncs]).toEqual([0, 0]);
    expect(b.visibilityListeners()).toBe(1);
  });

  test("an unsubscribed listener gets no events; the last unsubscribe closes the connection", async () => {
    const b = fakeBrowser();
    const first = recorder(b.live);
    const second = recorder(b.live);

    first.unsubscribe();
    await settle();
    b.send(CHANGED);
    expect(first.events).toEqual([]);
    expect(second.events).toEqual([CHANGED]);
    expect(b.opened()).toHaveLength(1);

    second.unsubscribe();
    await settle();
    expect(b.opened()).toHaveLength(0);
  });

  test("a page change (unsubscribe and subscribe in a row) leaves the connection alone", async () => {
    const b = fakeBrowser();
    const old = recorder(b.live);

    old.unsubscribe();
    const next = recorder(b.live);
    await settle();
    b.send(INDEXED);

    expect(b.connections).toHaveLength(1);
    expect(b.opened()).toHaveLength(1);
    expect(next.events).toEqual([INDEXED]);
    expect(next.state.resyncs).toBe(0);
  });

  test("a subscription after closing opens the connection again and rereads nothing", async () => {
    const b = fakeBrowser();
    recorder(b.live).unsubscribe();
    await settle();

    const next = recorder(b.live);
    b.last().onOpen();

    expect(b.connections).toHaveLength(2);
    expect(b.opened()).toHaveLength(1);
    expect(next.state.resyncs).toBe(0);
  });
});

describe("drop", () => {
  test("the connection closes, reopens after RECONNECT_MS, subscribers reread", () => {
    jest.useFakeTimers();
    const b = fakeBrowser();
    const page = recorder(b.live);
    b.last().onOpen();

    b.last().onError();
    expect(b.opened()).toHaveLength(0);
    jest.advanceTimersByTime(RECONNECT_MS - 1);
    expect(b.connections).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(b.connections).toHaveLength(2);
    // Until the new connection is open it is too early to reread: the server may not be responding yet.
    expect(page.state.resyncs).toBe(0);

    b.last().onOpen();
    expect(page.state.resyncs).toBe(1);
    b.send(CHANGED);
    expect(page.events).toEqual([CHANGED]);
  });

  test("the server does not respond: attempts are repeated, rereading happens once, after a successful one", () => {
    jest.useFakeTimers();
    const b = fakeBrowser();
    const page = recorder(b.live);
    b.last().onOpen();

    for (let attempt = 0; attempt < 3; attempt++) {
      b.last().onError();
      jest.advanceTimersByTime(RECONNECT_MS);
    }
    expect(b.connections).toHaveLength(4);
    expect(b.opened()).toHaveLength(1);
    expect(page.state.resyncs).toBe(0);

    b.last().onOpen();
    expect(page.state.resyncs).toBe(1);
  });

  test("unsubscribing while waiting cancels the new attempt", async () => {
    jest.useFakeTimers();
    const b = fakeBrowser();
    const page = recorder(b.live);
    b.last().onError();

    page.unsubscribe();
    await settle();
    jest.advanceTimersByTime(RECONNECT_MS * 2);

    expect(b.connections).toHaveLength(1);
  });

  test("a subscriber that arrived during a drop rereads along with everyone else", () => {
    jest.useFakeTimers();
    const b = fakeBrowser();
    recorder(b.live);
    b.last().onError();
    const late = recorder(b.live);

    jest.advanceTimersByTime(RECONNECT_MS);
    b.last().onOpen();

    expect(b.connections).toHaveLength(2);
    expect(late.state.resyncs).toBe(1);
  });
});

describe("hidden tab", () => {
  test("releases the connection and rereads on return", () => {
    const b = fakeBrowser();
    const page = recorder(b.live);
    b.last().onOpen();

    b.setVisible(false);
    expect(b.opened()).toHaveLength(0);

    b.setVisible(true);
    expect(b.connections).toHaveLength(2);
    expect(page.state.resyncs).toBe(0);
    b.last().onOpen();
    expect(page.state.resyncs).toBe(1);
  });

  test("a tab hidden during a drop does not reconnect until it is shown", () => {
    jest.useFakeTimers();
    const b = fakeBrowser();
    const page = recorder(b.live);
    b.last().onError();

    b.setVisible(false);
    jest.advanceTimersByTime(RECONNECT_MS * 2);
    expect(b.connections).toHaveLength(1);

    b.setVisible(true);
    b.last().onOpen();
    expect(b.connections).toHaveLength(2);
    expect(page.state.resyncs).toBe(1);
  });

  test("a subscription in a hidden tab waits for it to be shown; the page loaded the first data itself", () => {
    const b = fakeBrowser();
    b.live.subscribe(() => {});
    b.setVisible(false);
    const page = recorder(b.live);
    expect(b.opened()).toHaveLength(0);

    b.setVisible(true);
    b.last().onOpen();
    expect(b.opened()).toHaveLength(1);
    // The tab was hidden while subscribers were alive: events could have been missed.
    expect(page.state.resyncs).toBe(1);
  });

  test("without subscribers showing the tab opens nothing", async () => {
    const b = fakeBrowser();
    recorder(b.live).unsubscribe();
    await settle();

    b.setVisible(false);
    b.setVisible(true);

    expect(b.connections).toHaveLength(1);
  });
});

describe("fixture mode", () => {
  const before = process.env.VITE_TORCH_FIXTURES;
  afterEach(() => {
    if (before === undefined) delete process.env.VITE_TORCH_FIXTURES;
    else process.env.VITE_TORCH_FIXTURES = before;
  });

  test("there is no server: the subscription opens nothing", () => {
    process.env.VITE_TORCH_FIXTURES = "1";
    // Outside a browser there is neither EventSource nor document: touching them would be an error.
    const unsubscribe = subscribe(() => {});
    expect(unsubscribe()).toBeUndefined();
  });
});

describe("concerns", () => {
  test("a session page listens to changes of its own session", () => {
    expect(concerns({ type: "session_changed", sessionId: "s1" }, "s1")).toBe(true);
    expect(concerns({ type: "session_changed", sessionId: "s2" }, "s1")).toBe(false);
    expect(concerns({ type: "index_updated", sessions: 3 }, "s1")).toBe(false);
  });

  test("a list and the dashboard listen to a completed pass", () => {
    expect(concerns({ type: "index_updated", sessions: 3 })).toBe(true);
    expect(concerns({ type: "session_changed", sessionId: "s1" })).toBe(false);
  });
});

describe("reloadQueue", () => {
  function queue() {
    const state = { reloads: 0 };
    return { state, q: reloadQueue(() => void state.reloads++) };
  }

  test("without a request in flight a change rereads immediately", () => {
    const { state, q } = queue();
    q.changed();
    expect(state.reloads).toBe(1);
  });

  test("changes during a request give one request after it", () => {
    const { state, q } = queue();
    q.setLoading(true);
    q.changed();
    q.changed();
    q.changed();
    expect(state.reloads).toBe(0);

    q.setLoading(false);
    expect(state.reloads).toBe(1);

    // The deferred reread is used up: the next finished request starts nothing.
    q.setLoading(true);
    q.setLoading(false);
    expect(state.reloads).toBe(1);
  });

  test("a request without changes ends without rereading", () => {
    const { state, q } = queue();
    q.setLoading(true);
    q.setLoading(false);
    expect(state.reloads).toBe(0);
  });
});
