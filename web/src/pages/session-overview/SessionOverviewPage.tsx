// The Session detail page, route /sessions/:id. Package W3.
// Requests and state are only here (plan §9.4); the blocks get ready values from model.ts.
// An agent from the Agents table opens in the details panel beside the overview: the selection is the `sel`
// parameter of the address, as on the timeline, and the panel is the same PanelContainer.
// The Errors tile shows the Errors list (the `errors` parameter); an error from it opens its tool call in the panel.
import { ArrowRight, Download } from "@carbon/icons-react";
import { Button, InlineNotification, SkeletonText, Tag } from "@carbon/react";
import { useState } from "react";
import { parseSelection } from "@contracts/selection.ts";
import { Link, useParams, useSearchParams } from "react-router";
import { Mono } from "../../components/atoms/Mono.tsx";
import { ErrorNotice } from "../../components/molecules/ErrorNotice.tsx";
import { StatTile, StatTileGrid } from "../../components/molecules/StatTile.tsx";
import { SessionContent, SessionHeader } from "../../components/templates/SessionLayout.tsx";
import { api } from "../../lib/api.ts";
import { useLiveReload } from "../../lib/live.ts";
import { ROUTES, sessionHref } from "../../lib/routes.ts";
import { useApi } from "../../lib/useApi.ts";
import { panelHref, withSelection } from "../panel/address.ts";
import { PanelContainer } from "../panel/PanelContainer.tsx";
import { AgentsTable } from "./components/AgentsTable.tsx";
import { ErrorsTable } from "./components/ErrorsTable.tsx";
import { PromptSection } from "./components/PromptSection.tsx";
import { Section } from "../../components/molecules/Section.tsx";
import { TokenUsage } from "./components/TokenUsage.tsx";
import { downloadJson } from "./download.ts";
import {
  agentRows,
  enrichmentNote,
  errorRows,
  errorsCaption,
  exportFileName,
  formatWindow,
  promptsModel,
  statusTag,
  summaryTiles,
  timeRange,
} from "./model.ts";
import styles from "./SessionOverviewPage.module.css";

const SELECTION_PARAM = "sel";
/** `errors=1`: the Errors list is shown. */
const ERRORS_PARAM = "errors";

/** Short form of the identifier for breadcrumbs. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function SessionOverviewPage() {
  const { id = "" } = useParams();
  const session = useApi(() => api.session(id), [id]);
  useLiveReload(session, id);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const s = session.data;
  const [search, setSearchParams] = useSearchParams();
  const sel = parseSelection(search.get(SELECTION_PARAM));
  const agentHref = (agentId: string) => `?${withSelection(search, { kind: "agent", id: agentId }).toString()}`;
  const errorHref = (callId: string) => `?${withSelection(search, { kind: "tool", id: callId }).toString()}`;
  const errorsShown = search.get(ERRORS_PARAM) === "1";
  const errorsToggleHref = (() => {
    const next = new URLSearchParams(search);
    if (errorsShown) next.delete(ERRORS_PARAM);
    else next.set(ERRORS_PARAM, "1");
    return `?${next.toString()}`;
  })();
  const closePanel = () =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(SELECTION_PARAM);
      return next;
    });

  async function exportJson() {
    setExporting(true);
    setExportError(null);
    try {
      downloadJson(exportFileName(id), await api.sessionExport(id));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }

  const tag = s && statusTag(s);
  const note = s && enrichmentNote(s);
  const prompts = s && promptsModel(s.prompts);

  return (
    <>
      <SessionHeader
        title={s?.name}
        breadcrumbs={[{ label: "Sessions", href: ROUTES.sessions }, { label: s ? shortId(s.id) : id }]}
        activeTab="overview"
        tabHrefs={{ overview: sessionHref("session", id), timeline: sessionHref("timeline", id) }}
        meta={
          s &&
          tag && (
            <>
              <Tag type={tag.tone} size="sm">
                {tag.label}
              </Tag>
              {note && (
                <Tag type="gray" size="sm" title="Durations are estimated where the session was not observed live">
                  {note}
                </Tag>
              )}
              {s.project && <span>{s.project}</span>}
              <span>{timeRange(s)}</span>
              {s.primaryModel && <Mono size="md">{s.primaryModel}</Mono>}
              <Mono size="md">{s.id}</Mono>
            </>
          )
        }
        actions={
          s && (
            <>
              <Button kind="ghost" size="md" renderIcon={Download} disabled={exporting} onClick={exportJson}>
                Export JSON
              </Button>
              <Button kind="primary" size="md" renderIcon={ArrowRight} as={Link} to={sessionHref("timeline", id)}>
                Open timeline
              </Button>
            </>
          )
        }
      />
      <div className={styles.workspace}>
        <div className={styles.main}>
          <SessionContent>
            {exportError && (
              <InlineNotification
                kind="error"
                title="Export failed"
                subtitle={exportError}
                onCloseButtonClick={() => setExportError(null)}
              />
            )}
            {session.error && !s && (
              <ErrorNotice title="Could not load the session" error={session.error} onRetry={session.reload} />
            )}
            {session.loading && !s && <SkeletonText paragraph lineCount={6} />}
            {s && (
              <>
                <StatTileGrid label="Session summary">
                  {summaryTiles(s).map(({ opensErrors, ...tile }) => (
                    <StatTile
                      key={tile.label}
                      {...tile}
                      {...(opensErrors && { href: errorsToggleHref, expanded: errorsShown })}
                    />
                  ))}
                </StatTileGrid>
                {errorsShown && s.toolErrorList.length > 0 && (
                  <Section id="errors-h" title="Errors" aside={errorsCaption(s.toolErrorList)}>
                    <ErrorsTable
                      rows={errorRows(s.toolErrorList, s.agents, s.startedAt)}
                      errorHref={errorHref}
                      selectedCallId={sel?.kind === "tool" ? sel.id : undefined}
                    />
                  </Section>
                )}
                <Section id="tok-h" title="Token usage">
                  <TokenUsage tokens={s.tokens} />
                </Section>
                {prompts && (
                  <Section id="prompt-h" title="Original prompt" aside={prompts.caption}>
                    <PromptSection model={prompts} />
                  </Section>
                )}
                <Section id="agents-h" title="Agents" aside={`Context window: ${formatWindow(s.contextWindow)} tokens`}>
                  <AgentsTable
                      rows={agentRows(s.agents)}
                      agentHref={agentHref}
                      selectedAgentId={sel?.kind === "agent" ? sel.id : undefined}
                    />
                </Section>
              </>
            )}
          </SessionContent>
        </div>
        {sel && (
          <div className={styles.panel}>
            <PanelContainer
              sessionId={id}
              selection={sel}
              sessionStart={s?.startedAt ?? undefined}
              dock="right"
              onClose={closePanel}
              detachedHref={panelHref(id, sel)}
            />
          </div>
        )}
      </div>
    </>
  );
}
