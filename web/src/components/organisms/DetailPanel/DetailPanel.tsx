// DetailPanel organism: the six detail panel views. Works the same in the timeline dock and in
// a separate tab: data and actions arrive as props (plan §9.4). Package W4.
//
// `DetailPanel` shows a loaded item; `DetailPanelShell` is the same frame (title,
// dock, close, "Back to …") with arbitrary content: the loader from pages/panel uses it
// while there is no data.
import { ArrowLeft, Close, Launch, OpenPanelBottom, OpenPanelLeft, OpenPanelRight } from "@carbon/icons-react";
import { IconButton } from "@carbon/react";
import type { ContentResponse } from "@contracts/api.ts";
import { type DetailPanelNavigation, formatSelection, type PanelDock } from "@contracts/selection.ts";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { type DetailPanelData, DOCK_OPTIONS, selectionOf, sessionIdOf, shortSessionId } from "./model.ts";
import type { ViewContext } from "./parts.tsx";
import { AgentView } from "./views/AgentView.tsx";
import { FileView } from "./views/FileView.tsx";
import { NetworkView } from "./views/NetworkView.tsx";
import { PromptView } from "./views/PromptView.tsx";
import { SessionView } from "./views/SessionView.tsx";
import { ToolCallView } from "./views/ToolCallView.tsx";
import styles from "./DetailPanel.module.css";

export type { DetailPanelData } from "./model.ts";

/** Panel frame: whatever does not depend on the selected item. */
export interface DetailPanelChrome extends Omit<DetailPanelNavigation, "onOpen"> {
  /** Set when the panel sits in the timeline dock; absent in a separate tab. */
  dock?: PanelDock;
  onDock?: (dock: PanelDock) => void;
  onClose?: () => void;
  /** Address of this panel for "Open in new tab". */
  detachedHref?: string;
  /** Timeline address for "Back to timeline" in a separate tab. */
  timelineHref?: string;
}

export interface DetailPanelProps extends DetailPanelNavigation, DetailPanelChrome {
  item: DetailPanelData;
  /** Session start: the time "+6:12" is counted from it; without it the time of day is shown. */
  sessionStart?: number;
  /** Loads the whole body for "Show all"; without it only the beginning of a long body is shown. */
  onLoadContent?: (contentId: number) => Promise<ContentResponse>;
}

export interface DetailPanelShellProps extends DetailPanelChrome {
  sessionId: string;
  /** Content key: when it changes, scroll and view state are reset. */
  contentKey?: string;
  children: ReactNode;
}

const DOCK_ICONS: Record<PanelDock, typeof OpenPanelLeft> = {
  left: OpenPanelLeft,
  bottom: OpenPanelBottom,
  right: OpenPanelRight,
};

export function DetailPanelShell({
  sessionId,
  contentKey,
  dock,
  onDock,
  onClose,
  detachedHref,
  timelineHref,
  onBack,
  backLabel,
  children,
}: DetailPanelShellProps) {
  return (
    <section className={styles.root} aria-label="Details">
      <div className={styles.bar}>
        <span className={styles.barTitle}>Details · {shortSessionId(sessionId)}</span>
        {dock !== undefined ? (
          <>
            {onDock && (
              <div role="group" aria-label="Dock panel" className={styles.docks}>
                {DOCK_OPTIONS.map((option) => {
                  const Icon = DOCK_ICONS[option.dock];
                  const pressed = option.dock === dock;
                  return (
                    <IconButton
                      key={option.dock}
                      kind="ghost"
                      size="sm"
                      align="bottom"
                      label={option.label}
                      isSelected={pressed}
                      aria-pressed={pressed}
                      onClick={() => onDock(option.dock)}
                    >
                      <Icon />
                    </IconButton>
                  );
                })}
              </div>
            )}
            {detachedHref && (
              <IconButton
                kind="ghost"
                size="sm"
                align="bottom"
                label="Open in new tab"
                href={detachedHref}
                target="_blank"
                rel="noreferrer"
              >
                <Launch />
              </IconButton>
            )}
            {onClose && (
              <IconButton kind="ghost" size="sm" align="bottom-end" label="Close panel" onClick={onClose}>
                <Close />
              </IconButton>
            )}
          </>
        ) : (
          timelineHref && (
            <Link to={timelineHref} className={styles.barLink}>
              Back to timeline
            </Link>
          )
        )}
      </div>
      {onBack && (
        <div className={styles.back}>
          <button type="button" className={`${styles.link} ${styles.linkBack}`} onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to {backLabel}
          </button>
        </div>
      )}
      <div key={contentKey} className={styles.body}>
        {children}
      </div>
    </section>
  );
}

function PanelView({ item, ctx }: { item: DetailPanelData; ctx: ViewContext }) {
  switch (item.kind) {
    case "session":
      return <SessionView session={item.data} ctx={ctx} />;
    case "agent":
      return <AgentView agent={item.data} ctx={ctx} />;
    case "tool":
      return <ToolCallView call={item.data} ctx={ctx} />;
    case "prompt":
      return <PromptView prompt={item.data} ctx={ctx} />;
    case "file":
      return <FileView file={item.data} ctx={ctx} />;
    case "net":
      return <NetworkView call={item.data} ctx={ctx} />;
  }
}

export function DetailPanel({ item, onOpen, sessionStart, onLoadContent, ...chrome }: DetailPanelProps) {
  return (
    <DetailPanelShell sessionId={sessionIdOf(item)} contentKey={formatSelection(selectionOf(item))} {...chrome}>
      <PanelView item={item} ctx={{ onOpen, sessionStart, onLoadContent }} />
    </DetailPanelShell>
  );
}
