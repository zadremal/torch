// Organism: a bar chart — Model calls and Tool calls on the dashboard.
// One of the two places that import Carbon Charts (plan §9.4): converts a series from @contracts to the
// library format, sets the series color from the mockup and the number format. The look of the axes, tooltips and
// toolbar is set by the library (plan §9.3).
import { type BarChartOptions, type ChartTabularData, ScaleTypes, SimpleBarChart } from "@carbon/charts-react";
import type { DashboardBucket, SeriesPoint } from "@contracts/api.ts";
import { DAY_BUCKET_HOURS } from "@contracts/constants.ts";
import { useMemo } from "react";
import { formatBucket, formatCount } from "../../../lib/format.ts";
import { ACTIVITY_COLORS } from "../../../styles/palette.ts";
import "./BarChart.scss";

export type BarChartMetric = keyof typeof ACTIVITY_COLORS;

export interface BarChartProps {
  /** What the chart counts: sets the title and the series color. */
  metric: BarChartMetric;
  /** Dashboard series: one point per bar, empty ones included. */
  points: SeriesPoint[];
  /** Bar width: the time format in the tooltip and the axis label. */
  bucket: DashboardBucket;
}

const TITLES: Record<BarChartMetric, string> = {
  modelCalls: "Model calls",
  toolCalls: "Tool calls",
};

const BUCKET_TITLES: Record<DashboardBucket, string> = {
  hours: `${DAY_BUCKET_HOURS}-hour bucket`,
  day: "Day",
  month: "Month",
};

/** Peak up to which value axis ticks are listed one by one. */
const SMALL_PEAK = 10;

export function BarChart({ metric, points, bucket }: BarChartProps) {
  const title = TITLES[metric];

  const data = useMemo<ChartTabularData>(
    () => points.map((point) => ({ group: title, date: new Date(point.start), value: point.value })),
    [points, title],
  );

  const total = points.reduce((sum, point) => sum + point.value, 0);
  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);

  const options = useMemo<BarChartOptions>(
    () => ({
      title,
      axes: {
        left: {
          mapsTo: "value",
          title: "Calls",
          ticks: {
            formatter: (tick: number | Date) => formatCount(Number(tick)),
            // Calls are whole numbers. With a small peak the library puts fractional ticks (0.2, 0.4, …), and their
            // rounded labels repeat: ticks are set as whole numbers.
            ...(peak <= SMALL_PEAK ? { values: Array.from({ length: peak + 1 }, (_, value) => value) } : {}),
          },
        },
        // Time scale: the library thins the labels itself at both 31 bars and 12.
        bottom: { mapsTo: "date", title: BUCKET_TITLES[bucket], scaleType: ScaleTypes.TIME },
      },
      color: { scale: { [title]: ACTIVITY_COLORS[metric] } },
      // There is one series, the title names it.
      legend: { enabled: false },
      tooltip: {
        valueFormatter: (value: unknown) => {
          if (value instanceof Date) return formatBucket(value.getTime(), bucket);
          return typeof value === "number" ? formatCount(value) : String(value);
        },
      },
      accessibility: { svgAriaLabel: `${title} per ${BUCKET_TITLES[bucket].toLowerCase()}` },
      // Height is not set: the chart takes the height of its block from the styles.
    }),
    [title, metric, bucket, peak],
  );

  return (
    <section className="torch-bar-chart" aria-label={title}>
      <p className="torch-bar-chart__summary">
        {formatCount(total)} total · peak {formatCount(peak)}
      </p>
      <div className="torch-bar-chart__plot">
        <SimpleBarChart data={data} options={options} />
      </div>
    </section>
  );
}
