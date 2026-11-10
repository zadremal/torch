// The details panel address: the selection in the `sel` parameter (record — @contracts/selection.ts) and the
// "Back to …" stack in the browser history entry state (plan §9.2). Pure functions: pages
// only call them.
import { formatSelection, parseSelection, type Selection } from "@contracts/selection.ts";
import { sessionHref } from "../../lib/routes.ts";

const SELECTION_PARAM = "sel";

/** Selection of the separate tab without the `sel` parameter or with an unintelligible value: the session view. */
export const DEFAULT_PANEL_SELECTION: Selection = { kind: "session" };

/** Selection from the separate tab's query string. */
export function panelSelection(search: URLSearchParams): Selection {
  return parseSelection(search.get(SELECTION_PARAM)) ?? DEFAULT_PANEL_SELECTION;
}

/** The same query string with a different selection: the other parameters (dock, mode, zoom) are kept. */
export function withSelection(search: URLSearchParams, sel: Selection): URLSearchParams {
  const next = new URLSearchParams(search);
  next.set(SELECTION_PARAM, formatSelection(sel));
  return next;
}

const selectionQuery = (sel: Selection) => withSelection(new URLSearchParams(), sel).toString();

/** Address of the separate tab with this selection: "Open in new tab". */
export function panelHref(sessionId: string, sel: Selection): string {
  return `${sessionHref("panel", sessionId)}?${selectionQuery(sel)}`;
}

/** Timeline address with the same selection: the separate tab's "Back to timeline". */
export function timelineHref(sessionId: string, sel: Selection): string {
  return `${sessionHref("timeline", sessionId)}?${selectionQuery(sel)}`;
}

/** History entry state: the label of the element we came from. Present only for transitions from the panel. */
export interface PanelHistoryState {
  panelBack: string;
}

export function panelHistoryState(backLabel: string): PanelHistoryState {
  return { panelBack: backLabel };
}

/** The "Back to …" label from the history entry state; undefined — there is nowhere to go back. */
export function backLabelFromState(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const label = (state as Partial<PanelHistoryState>).panelBack;
  return typeof label === "string" && label !== "" ? label : undefined;
}
