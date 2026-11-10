// Shared data-loading hook (plan §4.2: `fetch` and one shared hook, no state library).
// Called only in pages: below them data flows down as props (plan §9.4).
import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  /** Response for the current parameters; on `reload` it stays on screen until a new one arrives. */
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Reread with the same parameters: the retry button and live-update events. */
  reload: () => void;
}

type LoadState<T> = Omit<ApiState<T>, "reload">;

/**
 * Loads data with the `load` function and reloads when `deps` change.
 * Example: `useApi(() => api.session(id), [id])`.
 *
 * `keepData` keeps the previous response on screen when the parameters change, until a new one arrives:
 * for a list under filters and charts under a range switcher, where the old rows are better than
 * an empty space. Not suitable for data of another object (another session).
 */
export function useApi<T>(load: () => Promise<T>, deps: DependencyList, options: { keepData?: boolean } = {}): ApiState<T> {
  const [state, setState] = useState<LoadState<T>>({ data: undefined, error: undefined, loading: true });
  const [attempt, setAttempt] = useState(0);
  const seenAttempt = useRef(attempt);

  useEffect(() => {
    // New parameters: the previous data belongs to another request and is removed;
    // a retry with the same parameters leaves it on screen.
    const isReload = seenAttempt.current !== attempt;
    seenAttempt.current = attempt;
    // The response of a stale request must not overwrite the response of a new one.
    let current = true;
    setState((prev) => ({ data: isReload || options.keepData ? prev.data : undefined, error: undefined, loading: true }));
    load().then(
      (data) => {
        if (current) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (current) {
          setState((prev) => ({
            data: prev.data,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          }));
        }
      },
    );
    return () => {
      current = false;
    };
    // `load` is intentionally not in the dependencies: when to call it again is set by the caller's `deps`.
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
