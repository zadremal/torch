// The Session timeline page, route /sessions/:id/timeline. Package W5.
// Requests and address state are only here (plan §9.4): the selection, dock, mode and scale are read from
// the address and written to it (urlState.ts); the Timeline organism gets everything via props. The panel in the dock is
// PanelContainer: it loads the selection data itself and keeps the "Back to …" stack of transitions within the panel.
import { Button, SkeletonText } from "@carbon/react";
import type { PanelDock, Selection, TimelineView, TimelineZoom } from "@contracts/selection.ts";
import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ErrorNotice } from "../../components/molecules/ErrorNotice.tsx";
import { panelSizeStyle, type ResizeEdge, ResizeHandle } from "../../components/molecules/ResizeHandle.tsx";
import { SegmentedControl, type SegmentedOption } from "../../components/molecules/SegmentedControl.tsx";
import { shortId } from "../../components/organisms/Timeline/model.ts";
import { Timeline } from "../../components/organisms/Timeline/Timeline.tsx";
import { TimelineLegend } from "../../components/organisms/Timeline/TimelineLegend.tsx";
import { SessionHeader } from "../../components/templates/SessionLayout.tsx";
import { api } from "../../lib/api.ts";
import { useLiveReload } from "../../lib/live.ts";
import { usePanelHeight, usePanelWidth } from "../../lib/panelSize.ts";
import { ROUTES, sessionHref } from "../../lib/routes.ts";
import { useApi } from "../../lib/useApi.ts";
import { panelHref } from "../panel/address.ts";
import { PanelContainer } from "../panel/PanelContainer.tsx";
import {
  type Navigation,
  closeNavigation,
  parseTimelineUrl,
  readHistoryState,
  reopenSelection,
  selectNavigation,
  viewNavigation,
} from "./urlState.ts";
import styles from "./SessionTimelinePage.module.css";

const WORKSPACE_CLASS: Record<PanelDock, string> = {
  right: styles.workspace,
  left: `${styles.workspace} ${styles.workspaceLeft}`,
  bottom: `${styles.workspace} ${styles.workspaceBottom}`,
};

/** The panel edge facing the timeline: the one the panel is resized by. */
const RESIZE_EDGE: Record<PanelDock, ResizeEdge> = { right: "left", left: "right", bottom: "top" };

/**
 * Panel size limits in pixels. Next to a side panel the timeline keeps `--torch-timeline-page-min-width`
 * (narrower and the panel would wrap under it); above the bottom panel it keeps a few lanes.
 */
const PANEL_MIN_WIDTH = 320;
const PANEL_MIN_HEIGHT = 160;
const TIMELINE_MIN_WIDTH = 560;
const TIMELINE_MIN_HEIGHT = 160;

const VIEW_OPTIONS: SegmentedOption<TimelineView>[] = [
  { value: "compact", label: "Compact" },
  { value: "expanded", label: "Expanded" },
];

const ZOOM_OPTIONS: SegmentedOption<TimelineZoom>[] = [
  { value: 1, label: "Fit" },
  { value: 2, label: "2×" },
  { value: 4, label: "4×" },
];

export function SessionTimelinePage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => parseTimelineUrl(location.search), [location.search]);
  const history = readHistoryState(location.state);

  const timeline = useApi(() => api.timeline(id), [id]);
  // A re-read keeps the previous response on the screen: selection, dock and scale are in the address, scroll is in the organism.
  useLiveReload(timeline, id);

  const go = (to: Navigation | null) => {
    if (to) navigate({ search: to.search ? `?${to.search}` : "" }, { replace: to.replace, state: to.state });
  };
  const select = (sel: Selection) => go(selectNavigation(state, sel));
  // The toggles replace the current history entry together with its state: the panel's "Back to …" stack stays.
  const setView = (view: TimelineView) => go(viewNavigation(state, { view }, location.state));
  const setZoom = (zoom: TimelineZoom) => go(viewNavigation(state, { zoom }, location.state));
  const setDock = (dock: PanelDock) => go(viewNavigation(state, { dock }, location.state));
  const close = () => go(closeNavigation(state));

  const data = timeline.data;
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [panelHeight, setPanelHeight] = usePanelHeight();
  const bottom = state.dock === "bottom";
  const panelSize = bottom ? panelHeight : panelWidth;

  return (
    <>
      <SessionHeader
        title={data?.session.name}
        breadcrumbs={[
          { label: "Sessions", href: ROUTES.sessions },
          { label: shortId(id), href: sessionHref("session", id) },
          { label: "Timeline" },
        ]}
        activeTab="timeline"
        tabHrefs={{ overview: sessionHref("session", id), timeline: sessionHref("timeline", id) }}
        wide
      />
      <div className={styles.root}>
        <div className={styles.toolbar}>
          <TimelineLegend />
          <div className={styles.controls}>
            <SegmentedControl label="Density" options={VIEW_OPTIONS} value={state.view} onChange={setView} />
            <SegmentedControl label="Zoom" options={ZOOM_OPTIONS} value={state.zoom} onChange={setZoom} />
            {!state.sel && (
              <Button kind="tertiary" size="sm" onClick={() => select(reopenSelection(history))}>
                Show details
              </Button>
            )}
          </div>
        </div>
        <div className={WORKSPACE_CLASS[state.dock]}>
          <div className={styles.main}>
            {timeline.error && !data && <ErrorNotice title="Could not load the timeline" error={timeline.error} onRetry={timeline.reload} />}
            {timeline.loading && !data && <SkeletonText paragraph lineCount={6} className={styles.skeleton} />}
            {data && <Timeline data={data} selection={state.sel} view={state.view} zoom={state.zoom} onSelect={select} />}
          </div>
          {state.sel && (
            <div className={styles.panel} style={panelSizeStyle(panelSize)}>
              <ResizeHandle
                edge={RESIZE_EDGE[state.dock]}
                size={panelSize}
                min={bottom ? PANEL_MIN_HEIGHT : PANEL_MIN_WIDTH}
                reserve={bottom ? TIMELINE_MIN_HEIGHT : TIMELINE_MIN_WIDTH}
                onResize={bottom ? setPanelHeight : setPanelWidth}
              />
              <PanelContainer
                sessionId={id}
                selection={state.sel}
                sessionStart={data?.session.startedAt}
                dock={state.dock}
                onDock={setDock}
                onClose={close}
                detachedHref={panelHref(id, state.sel)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
