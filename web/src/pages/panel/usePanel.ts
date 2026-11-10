// Hooks of pages with the details panel: loading the data of the selected element and the "Back to …" stack.
// Used by the separate tab (PanelPage) and the timeline page — through PanelContainer
// or directly.
import { formatSelection, type Selection } from "@contracts/selection.ts";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { backLabel, type DetailPanelData } from "../../components/organisms/DetailPanel/model.ts";
import { type ApiState, useApi } from "../../lib/useApi.ts";
import { backLabelFromState, panelHistoryState, withSelection } from "./address.ts";
import { loadPanelItem } from "./load.ts";

/** Panel data for the selection; reloaded when the session or the selection changes. */
export function usePanelItem(sessionId: string, selection: Selection): ApiState<DetailPanelData> {
  return useApi(() => loadPanelItem(sessionId, selection), [sessionId, formatSelection(selection)]);
}

export interface PanelHistory {
  /** Open another element from the panel: a new history entry labeled with the current element. */
  open: (next: Selection, from: DetailPanelData) => void;
  /** Back through history; undefined if the current entry did not arise from a transition within the panel. */
  onBack?: () => void;
  backLabel?: string;
}

/**
  * The panel selection stack in the browser history (plan §9.2). A transition from the panel changes only the
  * `sel` parameter of the current address and puts into the entry state the label of the element we left;
  * "Back to …" is a history step back, so the browser button and the panel button behave the same.
 */
export function usePanelHistory(): PanelHistory {
  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const label = backLabelFromState(location.state);
  return {
    open: (next, from) =>
      setSearchParams((search) => withSelection(search, next), { state: panelHistoryState(backLabel(from)) }),
    onBack: label === undefined ? undefined : () => navigate(-1),
    backLabel: label,
  };
}
