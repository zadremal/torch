// Selection for the details panel and the timeline state in the page address (plan §9.1).
// Six panel kinds: session, agent, tool, prompt, file, net.

import type { NetworkKind } from "./api.ts";
import { PANEL_DOCKS, TIMELINE_VIEWS, TIMELINE_ZOOMS } from "./constants.ts";

export type Selection =
  | { kind: "session" }
  | { kind: "agent"; id: string }
  | { kind: "tool"; id: string }
  | { kind: "prompt"; id: string }
  /** id is the file path. */
  | { kind: "file"; id: string }
  /** id is a requestId, an API error identifier or a tool call, depending on `net`. */
  | { kind: "net"; net: NetworkKind; id: string };

export type SelectionKind = Selection["kind"];

export type PanelDock = (typeof PANEL_DOCKS)[number];
export type TimelineView = (typeof TIMELINE_VIEWS)[number];
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];

/** Parameters of the address `/sessions/:id/timeline` and `/sessions/:id/panel`. */
export interface TimelineUrlState {
  sel: Selection | null;
  dock: PanelDock;
  view: TimelineView;
  zoom: TimelineZoom;
}

export const DEFAULT_TIMELINE_URL_STATE: TimelineUrlState = { sel: null, dock: "right", view: "compact", zoom: 1 };

const NET_KINDS: readonly NetworkKind[] = ["model", "error", "external"];

/** Selection record in the `sel` parameter: `session`, `tool:<id>`, `net:model:<id>`. */
export function formatSelection(sel: Selection): string {
  switch (sel.kind) {
    case "session":
      return "session";
    case "net":
      return `net:${sel.net}:${sel.id}`;
    default:
      return `${sel.kind}:${sel.id}`;
  }
}

/** Inverse of formatSelection; null for an empty or unrecognized record. */
export function parseSelection(value: string | null | undefined): Selection | null {
  if (!value) return null;
  if (value === "session") return { kind: "session" };
  const sep = value.indexOf(":");
  if (sep < 1) return null;
  const kind = value.slice(0, sep);
  const rest = value.slice(sep + 1);
  if (!rest) return null;
  if (kind === "agent" || kind === "tool" || kind === "prompt" || kind === "file") return { kind, id: rest };
  if (kind === "net") {
    const sep2 = rest.indexOf(":");
    const net = rest.slice(0, sep2) as NetworkKind;
    const id = rest.slice(sep2 + 1);
    if (sep2 > 0 && id && NET_KINDS.includes(net)) return { kind: "net", net, id };
  }
  return null;
}

/** Properties of the DetailPanel organism: the data and callbacks come from the page (plan §9.4). */
export interface DetailPanelNavigation {
  /** Open another item from the panel. */
  onOpen: (sel: Selection) => void;
  /** Return to the previous selection; undefined if there is nowhere to return. */
  onBack?: () => void;
  /** Caption of the "Back to …" button. */
  backLabel?: string;
}
