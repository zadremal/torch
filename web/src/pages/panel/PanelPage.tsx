// The Detail panel page in a separate tab, route /sessions/:id/panel. Package W4.
// The same view as in the timeline dock: the selection is read from the `sel` parameter, without it — the session view.
import { useParams, useSearchParams } from "react-router";
import { api } from "../../lib/api.ts";
import { useApi } from "../../lib/useApi.ts";
import { panelSelection, timelineHref } from "./address.ts";
import { PanelContainer } from "./PanelContainer.tsx";
import styles from "./PanelPage.module.css";

export function PanelPage() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const selection = panelSelection(search);
  // Session start: the panel counts call times from it. The timeline knows it from its own response,
  // the separate tab takes it from the overview.
  const session = useApi(() => api.session(id), [id]);

  return (
    <main className={styles.root}>
      <PanelContainer
        sessionId={id}
        selection={selection}
        sessionStart={session.data?.startedAt ?? undefined}
        timelineHref={timelineHref(id, selection)}
      />
    </main>
  );
}
