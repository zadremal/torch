// Showcase of the shared W1 components on examples from test/fixtures/dto. For development mode only:
// /dev/showcase — the PageLayout template, atoms, molecules, charts; /dev/session — the SessionLayout template.
// Temporary: removed together with the routes in App.tsx once screens W2–W7 show all of this themselves.
import { Button, Tag } from "@carbon/react";
import { ArrowRight, Download } from "@carbon/icons-react";
import type { DashboardRange } from "@contracts/api.ts";
import { AGENT_BUCKETS, TIMELINE_ZOOMS } from "@contracts/constants.ts";
import { type ReactNode, useState } from "react";
import { useSearchParams } from "react-router";
import { Meter } from "../components/atoms/Meter.tsx";
import { Mono } from "../components/atoms/Mono.tsx";
import { Swatch } from "../components/atoms/Swatch.tsx";
import { TimelineMark, type TimelineMarkKind } from "../components/atoms/TimelineMark.tsx";
import { CallRow } from "../components/molecules/CallRow.tsx";
import { KeyValue, KeyValueList } from "../components/molecules/KeyValue.tsx";
import { RangeFilter, type RangeValue } from "../components/molecules/RangeFilter.tsx";
import { SegmentedControl } from "../components/molecules/SegmentedControl.tsx";
import { StatTile, StatTileGrid } from "../components/molecules/StatTile.tsx";
import { BarChart } from "../components/organisms/BarChart/BarChart.tsx";
import { ProportionChart } from "../components/organisms/ProportionChart/ProportionChart.tsx";
import { PageLayout } from "../components/templates/PageLayout.tsx";
import { SessionContent, SessionHeader } from "../components/templates/SessionLayout.tsx";
import { fixtureResponse } from "../lib/fixtures.ts";
import {
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatOffset,
  formatPercent,
  formatTokens,
} from "../lib/format.ts";
import { ROUTES } from "../lib/routes.ts";
import { useApi } from "../lib/useApi.ts";
import { CONTEXT_STAGE_COLORS, TOKEN_COLORS, TOOL_USAGE_COLOR } from "../styles/palette.ts";
import styles from "./Showcase.module.css";

const SESSION_SHOWCASE_PATH = "/dev/session";

const RANGES: { value: DashboardRange; label: string }[] = [
  { value: "day", label: "Last day" },
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
  { value: "year", label: "Last year" },
  { value: "custom", label: "Custom" },
];

const AGENT_OPTIONS = (Object.keys(AGENT_BUCKETS) as (keyof typeof AGENT_BUCKETS)[]).map((value) => ({
  value,
  label: { any: "Any", one: "1", few: "2–3", many: "4+" }[value],
}));

const MARK_KINDS: { kind: TimelineMarkKind; label: string }[] = [
  { kind: "agent", label: "Agent run" },
  { kind: "tool", label: "Tool call" },
  { kind: "prompt", label: "Prompt" },
  { kind: "file-read", label: "File read" },
  { kind: "file-write", label: "File edit or write" },
  { kind: "model", label: "Model API call" },
  { kind: "external", label: "External request" },
];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.block}>
      <h2 className={styles.title}>{title}</h2>
      {children}
    </section>
  );
}

export function ComponentsShowcase() {
  const [range, setRange] = useState<DashboardRange>("week");
  const [dates, setDates] = useState<RangeValue>({ min: "2026-10-01", max: "2026-10-31" });
  const [bucket, setBucket] = useState<keyof typeof AGENT_BUCKETS>("any");
  const [toolCalls, setToolCalls] = useState<RangeValue>({ min: "", max: "" });
  const [zoom, setZoom] = useState<(typeof TIMELINE_ZOOMS)[number]>(1);
  const [mark, setMark] = useState("tool");

  const dashboard = useApi(() => fixtureResponse("dashboard", {}, { range }), [range]);
  const agent = useApi(() => fixtureResponse("agent", { agentId: "gp-1" }), []);

  const d = dashboard.data;
  const a = agent.data;

  return (
    <PageLayout
      title="Components"
      description={
        <>
          W1 building blocks on fixture data. Session template: <a href={SESSION_SHOWCASE_PATH}>{SESSION_SHOWCASE_PATH}</a>
        </>
      }
      actions={
        <>
          {range === "custom" && (
            <RangeFilter
              legend="Date range"
              hideLegend
              type="date"
              minLabel="From"
              maxLabel="To"
              value={dates}
              onChange={setDates}
            />
          )}
          <SegmentedControl label="Time range" size="md" options={RANGES} value={range} onChange={setRange} />
        </>
      }
    >
      {d && (
        <>
          <StatTileGrid label="Totals">
            <StatTile label="Sessions" value={formatCount(d.totals.sessions.value)} helper={`${d.totals.sessions.prev} in previous period`} />
            <StatTile label="Model calls" value={formatCount(d.totals.modelCalls.value)} />
            <StatTile label="Tool calls" value={formatCount(d.totals.toolCalls.value)} />
            <StatTile label="Total tokens" value={formatTokens(d.totals.tokens.value)} />
            <StatTile label="Cost" value={formatMoney(d.totals.costUsd.value)} helper="Unknown cost shows as —" />
            <StatTile
              label="Errors"
              value={formatCount(d.totals.errors.value)}
              error={d.totals.errors.value > 0}
              helper={`${formatPercent(d.totals.errors.value / d.totals.toolCalls.value, 1)} of tool calls`}
            />
          </StatTileGrid>

          <div className={styles.charts}>
            <BarChart metric="modelCalls" points={d.series.modelCalls} bucket={d.bucket} />
            <BarChart metric="toolCalls" points={d.series.toolCalls} bucket={d.bucket} />
          </div>

          <Block title="ProportionChart: token mix">
            <ProportionChart kind="tokens" label="Token mix" tokens={d.tokenMix} />
          </Block>
        </>
      )}

      {a && (
        <>
          <Block title="ProportionChart: context at peak">
            <ProportionChart kind="context" label="Context at peak" breakdown={a.ctxBreakdown} />
          </Block>

          <Block title="Meter, Swatch, Mono">
            <div className={styles.meters}>
              {(["first", "last", "peak"] as const).map((stage) => {
                const tokens = { first: a.ctxFirst, last: a.ctxLast, peak: a.ctxPeak }[stage];
                return (
                  <div key={stage} className={styles.meterRow}>
                    <span>{stage}</span>
                    <Meter ratio={(tokens ?? 0) / (a.ctxWindow ?? 1)} color={CONTEXT_STAGE_COLORS[stage]} />
                    <span>{formatTokens(tokens)}</span>
                  </div>
                );
              })}
              {a.toolUsage.map((usage) => (
                <div key={usage.name} className={styles.meterRow}>
                  <Mono size="md">{usage.name}</Mono>
                  <Meter ratio={usage.count / (a.toolUsage[0]?.count ?? 1)} color={TOOL_USAGE_COLOR} track={false} />
                  <span>{usage.count}</span>
                </div>
              ))}
            </div>
            <div className={styles.row}>
              {Object.entries(TOKEN_COLORS).map(([name, color]) => (
                <span key={name} className={styles.legend}>
                  <Swatch color={color} /> {name}
                </span>
              ))}
              <Mono tone="helper">{a.sessionId} · billing-web</Mono>
            </div>
          </Block>

          <Block title="KeyValue">
            <KeyValueList>
              <KeyValue label="ID">
                <Mono>{a.agentId}</Mono>
              </KeyValue>
              <KeyValue label="Type">{a.type}</KeyValue>
              <KeyValue label="Start">{formatClock(a.startedAt)}</KeyValue>
              <KeyValue label="Duration">{formatDuration(a.runMs)}</KeyValue>
              <KeyValue label="Tokens">{formatTokens(a.tokens.total)}</KeyValue>
              <KeyValue label="Cost">{formatMoney(a.costUsd)}</KeyValue>
              <KeyValue label="Errors" error={a.toolErrors > 0}>
                {a.toolErrors}
              </KeyValue>
            </KeyValueList>
          </Block>

          <Block title="CallRow">
            <div role="list">
              {a.calls.slice(0, 12).map((call, index) => (
                <div role="listitem" key={call.id}>
                  <CallRow
                    time={formatOffset(call.start - (a.startedAt ?? call.start))}
                    name={call.name}
                    detail={call.target ?? ""}
                    duration={formatDuration(call.durationMs)}
                    error={call.status === "error"}
                    current={index === 1}
                    onSelect={() => undefined}
                  />
                </div>
              ))}
            </div>
          </Block>
        </>
      )}

      <Block title="SegmentedControl, RangeFilter">
        <div className={`${styles.row} ${styles.rowEnd}`}>
          <SegmentedControl label="Agents" showLabel options={AGENT_OPTIONS} value={bucket} onChange={setBucket} />
          <RangeFilter legend="Tool calls" value={toolCalls} onChange={setToolCalls} />
          <SegmentedControl
            label="Zoom"
            options={TIMELINE_ZOOMS.map((value) => ({ value, label: value === 1 ? "Fit" : `${value}×` }))}
            value={zoom}
            onChange={setZoom}
          />
        </div>
      </Block>

      <Block title="TimelineMark">
        <ul className={`${styles.row} ${styles.marks}`}>
          {MARK_KINDS.map(({ kind, label }) => (
            <li key={kind} className={styles.legend}>
              <TimelineMark kind={kind} label={label} /> {label}
            </li>
          ))}
          <li className={styles.legend}>
            <TimelineMark kind="tool" label="Error" error /> Error (any item that failed)
          </li>
        </ul>
        <div className={styles.lane}>
          <TimelineMark kind="session" label="Session" left="0" width="100%" selected={mark === "session"} onSelect={() => setMark("session")}>
            Session · 186 tool calls
          </TimelineMark>
        </div>
        <div className={styles.lane}>
          <TimelineMark kind="prompt" label="Original prompt" left="2%" selected={mark === "prompt"} onSelect={() => setMark("prompt")} />
          <TimelineMark kind="agent-compact" label="Explore" left="6%" width="13%" top="5px" selected={mark === "agent"} onSelect={() => setMark("agent")} />
          <TimelineMark kind="agent-compact" label="general-purpose" left="54%" width="26%" top="16px" dimmed onSelect={() => setMark("agent2")} selected={mark === "agent2"} />
          <TimelineMark kind="tool" label="Read index.ts" left="24%" width="max(3px, 2%)" selected={mark === "tool"} onSelect={() => setMark("tool")} />
          <TimelineMark kind="tool" label="Bash bun test, failed" left="33%" width="max(3px, 4%)" error selected={mark === "tool-error"} onSelect={() => setMark("tool-error")} />
          <TimelineMark kind="file-read" label="Read schemas.ts" left="42%" selected={mark === "read"} onSelect={() => setMark("read")} />
          <TimelineMark kind="file-write" label="Edit schemas.ts" left="46%" selected={mark === "write"} onSelect={() => setMark("write")} />
          <TimelineMark kind="model" label="Model API call" left="85%" selected={mark === "model"} onSelect={() => setMark("model")} />
          <TimelineMark kind="external" label="WebFetch" left="90%" selected={mark === "external"} onSelect={() => setMark("external")} />
        </div>
      </Block>
    </PageLayout>
  );
}

export function SessionShowcase() {
  const [params] = useSearchParams();
  const timeline = params.get("tab") === "timeline";
  const session = useApi(() => fixtureResponse("session", { id: "any" }), []);
  const s = session.data;

  return (
    <>
      <SessionHeader
        title={s?.name}
        breadcrumbs={
          timeline
            ? [{ label: "Sessions", href: ROUTES.sessions }, { label: "s-0142", href: SESSION_SHOWCASE_PATH }, { label: "Timeline" }]
            : [{ label: "Sessions", href: ROUTES.sessions }, { label: "s-0142" }]
        }
        activeTab={timeline ? "timeline" : "overview"}
        tabHrefs={{ overview: SESSION_SHOWCASE_PATH, timeline: `${SESSION_SHOWCASE_PATH}?tab=timeline` }}
        wide={timeline}
        meta={
          !timeline &&
          s && (
            <>
              <Tag type="green" size="sm">
                Completed
              </Tag>
              <span>{s.project}</span>
              <span>{formatDateTime(s.startedAt)}</span>
              <Mono size="md">{s.primaryModel}</Mono>
            </>
          )
        }
        actions={
          !timeline && (
            <>
              <Button kind="ghost" size="md" renderIcon={Download}>
                Export JSON
              </Button>
              <Button kind="primary" size="md" renderIcon={ArrowRight}>
                Open timeline
              </Button>
            </>
          )
        }
      />
      {s && !timeline && (
        <SessionContent>
          <StatTileGrid label="Session summary">
            <StatTile label="Duration" value={formatDuration(s.activeMs)} helper={`${formatDuration(s.modelMs)} of model time`} />
            <StatTile label="Total tokens" value={formatTokens(s.tokens.total)} />
            <StatTile label="Errors" value={String(s.toolErrors)} error={s.toolErrors > 0} helper={`${formatPercent(s.toolErrors / s.toolCalls, 1)} of ${s.toolCalls} tool calls`} />
            <StatTile label="Agents" value={String(s.agentsCount)} />
            <StatTile label="Model calls" value={String(s.modelCalls)} helper={`${s.toolCalls} tool calls`} />
            <StatTile label="Cost" value={formatMoney(s.costUsd)} helper="Estimated at list prices" />
          </StatTileGrid>
          <Block title="Token usage">
            <ProportionChart kind="tokens" label="Token usage" tokens={s.tokens} />
          </Block>
        </SessionContent>
      )}
    </>
  );
}
