// Watching the transcripts directory and launching an incremental pass. Package L1.
import { watch, type FSWatcher } from "node:fs";
import type { IndexResult } from "../contracts/pipeline.ts";
import { IndexError, runIndex, type IndexDeps } from "./index.ts";

/**
 * How long to wait after a file change before a pass. The lines of one response and the subagent files
 * are written in a burst: during this time they are gathered into a single pass.
 */
export const WATCH_DELAY_MS = 500;

/**
 * A clock-driven pass, with no file changes. Through it a running session that has stopped being written to
 * becomes finished, desktop app titles arrive (they live outside the transcripts
 * directory) and watching starts for a directory that did not exist at startup.
 */
export const WATCH_TICK_MS = 10_000;

/**
 * Rest after a pass: this many times longer than the pass took. A pass occupies the whole event loop,
 * and on a large history it is not instantaneous: this way watching takes no more than a fifth of the time,
 * and the rest goes to API requests.
 */
export const PASS_REST = 4;

/** What distinguishes a pass failure from the previous one: the same failure is reported once. */
function failureKey(error: unknown): string {
  if (error instanceof IndexError) return error.failures.map((failure) => failure.path).join("\n");
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts watching; returns a stop function. `onIndexed` receives the sessions changed by
 * the pass, and is not called when the pass changed nothing. `onError` receives a pass failure:
 * watching continues after it, and sessions from the files that could be read reach
 * `onIndexed` as usual.
 */
export function startWatcher(deps: IndexDeps, onIndexed: (sessionIds: string[]) => void, onError: (error: unknown) => void = () => {}): () => void {
  let watcher: FSWatcher | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let lastFailure = "";
  /** Until this time the next pass does not start. */
  let restUntil = 0;

  const report = (error: unknown): void => {
    const key = failureKey(error);
    if (key !== lastFailure) onError(error);
    lastFailure = key;
  };

  const pass = (startedAt: number): void => {
    scheduled = null;
    watchDir();
    let result: IndexResult | null = null;
    try {
      result = runIndex(deps);
      lastFailure = "";
    } catch (error) {
      report(error);
      // Bad files do not stop the rest from loading; any other failure means the pass did not happen.
      if (error instanceof IndexError) result = error.result;
    }
    const endedAt = deps.now();
    restUntil = endedAt + (endedAt - startedAt) * PASS_REST;
    if (result && result.sessionsChanged.length > 0) onIndexed(result.sessionsChanged);
  };

  // The first change schedules a pass, later ones change nothing before it: a running session is written to
  // continuously, and counting from the last change would postpone the pass indefinitely.
  const schedule = (): void => {
    scheduled ??= setTimeout(() => pass(deps.now()), Math.max(WATCH_DELAY_MS, restUntil - deps.now()));
  };

  function watchDir(): void {
    if (watcher) return;
    try {
      const started = watch(deps.config.transcriptsDir, { recursive: true }, schedule);
      started.on("error", () => {
        started.close();
        if (watcher === started) watcher = null;
      });
      watcher = started;
    } catch {
      // The directory is absent or unreadable: clock-driven passes go on, watching starts when it appears.
    }
  }

  watchDir();
  const tick = setInterval(() => {
    const now = deps.now();
    if (scheduled === null && now >= restUntil) pass(now);
  }, WATCH_TICK_MS);

  return () => {
    clearInterval(tick);
    if (scheduled !== null) clearTimeout(scheduled);
    watcher?.close();
  };
}
