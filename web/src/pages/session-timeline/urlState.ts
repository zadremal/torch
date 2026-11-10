// Timeline state ↔ address string (plan §9.1): sel, dock, view, zoom. Pure functions:
// the page only calls them. The selection record is formatSelection and parseSelection from the contract.
import { PANEL_DOCKS, TIMELINE_VIEWS, TIMELINE_ZOOMS } from "@contracts/constants.ts";
import {
  DEFAULT_TIMELINE_URL_STATE,
  type Selection,
  type TimelineUrlState,
  formatSelection,
  parseSelection,
} from "@contracts/selection.ts";

function pick<T extends string | number>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((value) => String(value) === raw) ?? fallback;
}

/** Address → state. Unintelligible values are replaced with the default: hand-editing the address does not break the page. */
export function parseTimelineUrl(search: string | URLSearchParams): TimelineUrlState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return {
    sel: parseSelection(params.get("sel")),
    dock: pick(params.get("dock"), PANEL_DOCKS, DEFAULT_TIMELINE_URL_STATE.dock),
    view: pick(params.get("view"), TIMELINE_VIEWS, DEFAULT_TIMELINE_URL_STATE.view),
    zoom: pick(params.get("zoom"), TIMELINE_ZOOMS, DEFAULT_TIMELINE_URL_STATE.zoom),
  };
}

/** State → address (without "?"); defaults are omitted. */
export function timelineSearch(state: TimelineUrlState): string {
  const params = new URLSearchParams();
  if (state.sel) params.set("sel", formatSelection(state.sel));
  if (state.dock !== DEFAULT_TIMELINE_URL_STATE.dock) params.set("dock", state.dock);
  if (state.view !== DEFAULT_TIMELINE_URL_STATE.view) params.set("view", state.view);
  if (state.zoom !== DEFAULT_TIMELINE_URL_STATE.zoom) params.set("zoom", String(state.zoom));
  return params.toString();
}

/** Selection record for comparison and for the browser history; null — nothing is selected. */
export function selectionKey(sel: Selection | null): string | null {
  return sel ? formatSelection(sel) : null;
}

/**
  * What the page puts into the browser history entry next to the address (plan §9.2: the panel selection stack
  * is kept in the history).
 */
export interface TimelineHistoryState {
  /** The selection the panel was closed with: "Show details" opens it again. */
  reopen?: string;
}

/** History entry state from `location.state`: a foreign or corrupted value is empty. */
export function readHistoryState(raw: unknown): TimelineHistoryState {
  if (typeof raw !== "object" || raw === null) return {};
  const { reopen } = raw as Record<string, unknown>;
  return { reopen: typeof reopen === "string" ? reopen : undefined };
}

export interface Navigation {
  search: string;
  /** true — replace the current history entry, false — add a new one. */
  replace: boolean;
  /** History entry state: its own (`TimelineHistoryState`) or kept as is when the entry is replaced. */
  state: unknown;
}

/**
  * Selecting a mark on the timeline: a new history entry. It does not give "Back to …": the button appears
  * only for transitions within the panel (pages/panel). null — the selection is already the same, no transition.
 */
export function selectNavigation(current: TimelineUrlState, sel: Selection): Navigation | null {
  if (selectionKey(current.sel) === formatSelection(sel)) return null;
  return { search: timelineSearch({ ...current, sel }), replace: false, state: {} };
}

/** Closing the panel: the selection leaves the address, the history entry remembers it for "Show details". */
export function closeNavigation(current: TimelineUrlState): Navigation {
  const from = selectionKey(current.sel);
  return { search: timelineSearch({ ...current, sel: null }), replace: false, state: from ? { reopen: from } : {} };
}

/** "Show details": the selection the panel was closed with; if there is none — the session panel. */
export function reopenSelection(history: TimelineHistoryState): Selection {
  return parseSelection(history.reopen) ?? { kind: "session" };
}

/**
  * Dock, mode and scale change the current history entry: "back" goes through selections, not
  * through toggles. The entry state (`location.state`) is kept as is: it also holds the
  * panel's "Back to …" stack.
 */
export function viewNavigation(
  current: TimelineUrlState,
  change: Partial<Pick<TimelineUrlState, "dock" | "view" | "zoom">>,
  historyState: unknown,
): Navigation {
  return { search: timelineSearch({ ...current, ...change }), replace: true, state: historyState };
}
