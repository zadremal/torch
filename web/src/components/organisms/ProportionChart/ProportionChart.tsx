// Organism: a composite share bar — Token usage on the session overview, Token mix on the dashboard,
// context at peak in the agent panel. One of the two places that import Carbon Charts (plan §9.4):
// converts data from @contracts to the library format and sets the series colors from the mockup.
//
// Built on MeterChart in proportional mode. The library draws the segments and the legend;
// it has no numeric labels on segments, so the value and share are part of the group name
// and are visible in the legend without hovering.
import { type ChartTabularData, MeterChart, type MeterChartOptions, TruncationTypes } from "@carbon/charts-react";
import type { ContextBreakdownEntry, ContextCategory, TokenTotals } from "@contracts/api.ts";
import { useMemo } from "react";
import { formatPercent, formatTokens } from "../../../lib/format.ts";
import { CONTEXT_COLORS, TOKEN_COLORS } from "../../../styles/palette.ts";
import styles from "./ProportionChart.module.css";

export type ProportionChartProps = {
  /** Chart name for assistive technologies; the screen sets the visible heading. */
  label: string;
} & (
  | { kind: "tokens"; tokens: TokenTotals }
  | { kind: "context"; breakdown: ContextBreakdownEntry[] }
);

interface Segment {
  name: string;
  value: number;
  color: string;
}

const CONTEXT_LABELS: Record<ContextCategory, string> = {
  system_tools: "System and tools",
  instructions: "Instructions",
  messages: "Messages",
  tool_results: "Tool results",
};

function toSegments(props: ProportionChartProps): Segment[] {
  if (props.kind === "context") {
    return props.breakdown.map((entry) => ({
      name: CONTEXT_LABELS[entry.category],
      value: entry.tokens,
      color: CONTEXT_COLORS[entry.category],
    }));
  }
  const { tokens } = props;
  // Thinking is part of output and is not shown as a separate segment.
  return [
    { name: "Input", value: tokens.input, color: TOKEN_COLORS.input },
    { name: "Output", value: tokens.output, color: TOKEN_COLORS.output },
    { name: "Cache read", value: tokens.cacheRead, color: TOKEN_COLORS.cacheRead },
    { name: "Cache write", value: tokens.cacheWrite, color: TOKEN_COLORS.cacheWrite },
  ];
}

export function ProportionChart(props: ProportionChartProps) {
  const segments = toSegments(props);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  // Recalculation key: the segment values, not the props object, which is new on every render.
  const key = segments.map((segment) => `${segment.name}:${segment.value}`).join("|");

  const { data, options } = useMemo(() => {
    const groups = segments.map((segment) => ({
      ...segment,
      group: `${segment.name} ${formatTokens(segment.value)} · ${formatPercent(total ? segment.value / total : 0)}`,
    }));
    const chartData: ChartTabularData = groups.map(({ group, value }) => ({ group, value }));
    const chartOptions: MeterChartOptions = {
      meter: {
        proportional: {
          // Equals the sum of the segments: the bar is filled completely, the "used of" line is not needed.
          total,
          totalFormatter: (value: number) => `${formatTokens(value)} total`,
        },
      },
      color: { scale: Object.fromEntries(groups.map(({ group, color }) => [group, color])) },
      // Group names carry the values: they must not be truncated.
      legend: { truncation: { type: TruncationTypes.NONE } },
      tooltip: { truncation: { type: TruncationTypes.NONE } },
      toolbar: { enabled: false },
      accessibility: { svgAriaLabel: props.label },
    };
    return { data: chartData, options: chartOptions };
    // `segments` and `total` are derived from `key`: new data and option objects would make the
    // library redraw the chart on every render of the parent.
  }, [key, props.label]);

  if (total === 0) {
    return <p className={`${styles.root} ${styles.empty}`}>No data</p>;
  }

  return (
    <div className={styles.root} role="group" aria-label={props.label}>
      <MeterChart data={data} options={options} />
    </div>
  );
}
