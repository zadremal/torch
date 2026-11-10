// Panel data by selection: each kind has its own API route (plan §8); the session view takes the overview.
import type { Selection } from "@contracts/selection.ts";
import type { DetailPanelData } from "../../components/organisms/DetailPanel/model.ts";
import { api } from "../../lib/api.ts";

export async function loadPanelItem(sessionId: string, sel: Selection): Promise<DetailPanelData> {
  switch (sel.kind) {
    case "session":
      return { kind: "session", data: await api.session(sessionId) };
    case "agent":
      return { kind: "agent", data: await api.agent(sessionId, sel.id) };
    case "tool":
      return { kind: "tool", data: await api.toolCall(sessionId, sel.id) };
    case "prompt":
      return { kind: "prompt", data: await api.prompt(sessionId, sel.id) };
    case "file":
      return { kind: "file", data: await api.file(sessionId, sel.id) };
    case "net":
      return { kind: "net", data: await api.network(sessionId, sel.net, sel.id) };
  }
}
