// The details panel with loading: requests data for the selection and shows the DetailPanel organism,
// and while there is no data, the same frame with a placeholder or an error. Requests and history live here,
// at the page level (plan §9.4); it is mounted in a separate tab and in the timeline dock.
import { SkeletonText } from "@carbon/react";
import type { Selection } from "@contracts/selection.ts";
import {
  DetailPanel,
  type DetailPanelChrome,
  DetailPanelShell,
} from "../../components/organisms/DetailPanel/DetailPanel.tsx";
import { api } from "../../lib/api.ts";
import { ErrorNotice } from "../../components/molecules/ErrorNotice.tsx";
import { useLiveReload } from "../../lib/live.ts";
import { usePanelHistory, usePanelItem } from "./usePanel.ts";
import "./PanelContainer.scss";

export interface PanelContainerProps extends Omit<DetailPanelChrome, "onBack" | "backLabel"> {
  sessionId: string;
  selection: Selection;
  /** Session start: the time "+6:12" is counted from it; without it the time of day is shown. */
  sessionStart?: number;
}

export function PanelContainer({ sessionId, selection, sessionStart, ...frame }: PanelContainerProps) {
  const item = usePanelItem(sessionId, selection);
  // A call without a result gets it while the panel is open: the selection data is re-read together with the session.
  useLiveReload(item, sessionId);
  const history = usePanelHistory();
  const chrome: DetailPanelChrome = { ...frame, onBack: history.onBack, backLabel: history.backLabel };
  const { data } = item;

  if (!data) {
    return (
      <DetailPanelShell sessionId={sessionId} {...chrome}>
        <div className="torch-panel-state">
          {item.error ? (
            <ErrorNotice title="Could not load details" error={item.error} onRetry={item.reload} />
          ) : (
            <SkeletonText paragraph lineCount={6} />
          )}
        </div>
      </DetailPanelShell>
    );
  }

  return (
    <DetailPanel
      item={data}
      {...chrome}
      sessionStart={sessionStart}
      onOpen={(next) => history.open(next, data)}
      onLoadContent={api.content}
    />
  );
}
