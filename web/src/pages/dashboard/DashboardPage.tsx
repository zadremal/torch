// The Dashboard page, route /. Package W6.
// The range, Custom dates and the temp-directories toggle live in the address; the totals, series, tops
// and tables are computed by the server, the page formats them (model.ts).
import { Checkbox, InlineNotification } from "@carbon/react";
import type { DashboardRange } from "@contracts/api.ts";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { StatTile, StatTileGrid } from "../../components/molecules/StatTile.tsx";
import { RangeFilter } from "../../components/molecules/RangeFilter.tsx";
import { ErrorNotice } from "../../components/molecules/ErrorNotice.tsx";
import { Section } from "../../components/molecules/Section.tsx";
import { SegmentedControl } from "../../components/molecules/SegmentedControl.tsx";
import { BarChart } from "../../components/organisms/BarChart/BarChart.tsx";
import { ProportionChart } from "../../components/organisms/ProportionChart/ProportionChart.tsx";
import { PageLayout } from "../../components/templates/PageLayout.tsx";
import { api } from "../../lib/api.ts";
import { formatPercent } from "../../lib/format.ts";
import { useLiveReload } from "../../lib/live.ts";
import { useApi } from "../../lib/useApi.ts";
import { Leaderboard } from "./components/Leaderboard.tsx";
import { ModelsTable, ToolsTable } from "./components/Tables.tsx";
import { BOARDS, cacheHitRate, formatWindow, leaderboardRows, modelRows, toolRows, totalTiles } from "./model.ts";
import { CUSTOM_ISSUE_TEXT, type DashboardState, customIssue, parseState, stateToQuery, stateToSearch } from "./query.ts";
import styles from "./DashboardPage.module.css";

const RANGE_OPTIONS: { value: DashboardRange; label: string }[] = [
  { value: "day", label: "Last day" },
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
  { value: "year", label: "Last year" },
  { value: "custom", label: "Custom" },
];

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const state = useMemo(() => parseState(search), [search]);

  // For Custom with unset or inconsistent dates there is no request: the server would answer 400.
  const query = stateToQuery(state);
  const issue = state.range === "custom" ? customIssue(state) : null;
  const dashboard = useApi(() => (query ? api.dashboard(query) : Promise.resolve(null)), [stateToSearch(state)], {
    keepData: true,
  });
  useLiveReload(dashboard);

  // Changing the range is a new history entry; typing dates edits the address in place.
  const go = (next: DashboardState, replace: boolean) => setParams(stateToSearch(next), { replace });

  const data = issue ? null : dashboard.data;
  const aside = data ? formatWindow(data) : undefined;

  return (
    <PageLayout
      title="Dashboard"
      description={`Model calls, tool calls and cost across your sessions${aside ? ` · ${aside}` : ""}`}
      actions={
        <>
          {state.range === "custom" && (
            <RangeFilter
              legend="Date range"
              hideLegend
              type="date"
              minLabel="From"
              maxLabel="To"
              value={{ min: state.from, max: state.to }}
              onChange={({ min, max }) => go({ ...state, from: min, to: max }, true)}
            />
          )}
          <SegmentedControl
            label="Time range"
            size="md"
            options={RANGE_OPTIONS}
            value={state.range}
            onChange={(range) => go({ ...state, range }, false)}
          />
        </>
      }
    >
      <Checkbox
        id="dashboard-temp"
        labelText="Show temporary directories"
        checked={state.temp}
        onChange={(_, { checked }) => go({ ...state, temp: checked }, true)}
      />
      {issue && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Choose a date range"
          subtitle={CUSTOM_ISSUE_TEXT[issue]}
        />
      )}
      {!issue && dashboard.error && (
        <ErrorNotice title="Could not load the dashboard" error={dashboard.error} onRetry={dashboard.reload} />
      )}
      {!issue && !data && dashboard.loading && <p className={styles.loading}>Loading…</p>}
      {data && (
        <>
          <StatTileGrid label="Totals">
            {totalTiles(data.totals).map((tile) => (
              <StatTile key={tile.label} {...tile} />
            ))}
          </StatTileGrid>

          <section aria-label="Activity" className={styles.charts}>
            <BarChart metric="modelCalls" points={data.series.modelCalls} bucket={data.bucket} />
            <BarChart metric="toolCalls" points={data.series.toolCalls} bucket={data.bucket} />
          </section>

          <Section
            id="dashboard-token-mix"
            title="Token mix"
            aside={`Cache hit rate ${formatPercent(cacheHitRate(data.tokenMix))} of input`}
          >
            <ProportionChart kind="tokens" label="Token mix" tokens={data.tokenMix} />
          </Section>

          <Section id="dashboard-insights" title="Insights">
            <div className={styles.boards}>
              {BOARDS.map((board) => (
                <Leaderboard
                  key={board.key}
                  title={board.title}
                  metric={board.metric}
                  rows={leaderboardRows(data.top[board.key], board.format)}
                />
              ))}
            </div>
          </Section>

          <div className={styles.tables}>
            <Section id="dashboard-tools" title="Tool calls by tool">
              <ToolsTable rows={toolRows(data.tools)} />
            </Section>
            <Section id="dashboard-models" title="Model calls by model">
              <ModelsTable rows={modelRows(data.models)} />
            </Section>
          </div>
        </>
      )}
    </PageLayout>
  );
}
