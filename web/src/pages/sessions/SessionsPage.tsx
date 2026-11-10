// The Sessions page, route /sessions. Package W2.
// The filter state lives in the address; filtering, sorting and pages are done by the server.
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { PageLayout } from "../../components/templates/PageLayout.tsx";
import { ErrorNotice } from "../../components/molecules/ErrorNotice.tsx";
import { api } from "../../lib/api.ts";
import { useLiveReload } from "../../lib/live.ts";
import { useApi } from "../../lib/useApi.ts";
import { SessionFilters } from "./components/SessionFilters.tsx";
import { SessionsPager } from "./components/SessionsPager.tsx";
import { SessionsTable } from "./components/SessionsTable.tsx";
import {
  type SessionsState,
  hasFilters,
  parseState,
  resetFilters,
  stateToQuery,
  stateToSearch,
  withFilter,
  withSort,
} from "./query.ts";
import "./SessionsPage.scss";

export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const state = useMemo(() => parseState(search), [search]);

  // The request depends on the whole address string: any state change is a new request.
  const sessions = useApi(() => api.sessions(stateToQuery(state)), [stateToSearch(state)], { keepData: true });
  const projects = useApi(() => api.projects({ temp: state.temp }), [state.temp]);
  // An indexer pass changes both the list rows and the set of projects; filters, sorting and page are in the address and stay.
  useLiveReload(sessions);
  useLiveReload(projects);

  // Typing in the fields edits the address in place so that "back" does not step through every letter; sorting and pages are new history entries.
  const go = (next: SessionsState, replace: boolean) => setParams(stateToSearch(next), { replace });
  const onChange = (change: Partial<SessionsState>) => go(withFilter(state, change), true);

  const data = sessions.data;
  return (
    <PageLayout
      title="Sessions"
      description="Claude Code sessions read from your local history. Select a session to see its agents, tokens and timeline."
    >
      <SessionFilters
        state={state}
        projects={projects.data?.projects ?? []}
        canReset={hasFilters(state)}
        onChange={onChange}
        onReset={() => go(resetFilters(state), true)}
      />
      <section aria-label="Session list" className="torch-slist">
        <div className="torch-slist__bar">
          <h2 className="torch-slist__title">All sessions</h2>
          <span className="torch-slist__count" aria-live="polite">
            {data ? `Showing ${data.total} of ${data.totalAll} sessions` : sessions.loading ? "Loading…" : ""}
          </span>
        </div>
        {sessions.error && (
          <ErrorNotice title="Could not load sessions" error={sessions.error} onRetry={sessions.reload} />
        )}
        {data && (
          <>
            <SessionsTable
              items={data.items}
              sort={state.sort}
              dir={state.dir}
              noSessions={data.totalAll === 0}
              onSort={(key) => go(withSort(state, key), false)}
            />
            <SessionsPager
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={(page) => go({ ...state, page }, false)}
            />
          </>
        )}
      </section>
    </PageLayout>
  );
}
