// Formatting of tokens, money, durations and time: the single place (plan §4.2).
// The look of the values is taken from the mockups: "2.18M", "168.2K", "$18.42", "18m 42s", "4.2 s", "300 ms".
// null means "unknown" and is shown as a dash.
import type { DashboardBucket } from "@contracts/api.ts";

/** Dash for an unknown value (plan §9.3: Cost for an unknown model). */
export const DASH = "—";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (value: number) => String(value).padStart(2, "0");

const grouped = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Abbreviation to K, M and B; below the `kFrom` threshold, an integer with thousands separators. */
function abbreviate(value: number, kFrom: number): string {
  const abs = Math.abs(value);
  // Thresholds are shifted by half of the last digit so as not to get "1000.0K" and "1000.00M".
  if (abs >= 999_995_000) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 999_950) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= kFrom) return `${(value / 1e3).toFixed(1)}K`;
  return grouped(String(Math.round(value)));
}

/** Tokens: 2184300 → "2.18M", 168200 → "168.2K", 412 → "412". */
export function formatTokens(value: number | null): string {
  return value === null ? DASH : abbreviate(value, 1000);
}

/** Counters (sessions, calls, errors): 1792 → "1,792", 48210 → "48.2K". */
export function formatCount(value: number | null): string {
  return value === null ? DASH : abbreviate(value, 10_000);
}

/** Money in dollars: 18.42 → "$18.42", 3391.7 → "$3,391.70"; an unknown cost is a dash. */
export function formatMoney(value: number | null): string {
  return value === null ? DASH : `$${grouped(value.toFixed(2))}`;
}

/** Duration: 300 → "300 ms", 4200 → "4.2 s", 668000 → "11m 08s", 5420000 → "1h 30m". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return DASH;
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  return `${minutes}m ${pad2(totalSeconds % 60)}s`;
}

/** Time since the session start in call rows and tick labels: 372000 → "+6:12". */
export function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `+${Math.floor(totalSeconds / 60)}:${pad2(totalSeconds % 60)}`;
}

/** Share: 0.74 → "74%"; with one decimal 0.0376 → "3.8%". */
export function formatPercent(ratio: number | null, digits = 0): string {
  return ratio === null ? DASH : `${(ratio * 100).toFixed(digits)}%`;
}

/** Time of day in the machine's local time: "14:02:11". */
export function formatClock(ts: number | null): string {
  if (ts === null) return DASH;
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Date and time in the machine's local time: "Oct 31, 14:02". */
export function formatDateTime(ts: number | null): string {
  if (ts === null) return DASH;
  const date = new Date(ts);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Dashboard bar label by its start: hours "14:00", day "Oct 25", month "Nov 2025". */
export function formatBucket(start: number, bucket: DashboardBucket): string {
  const date = new Date(start);
  switch (bucket) {
    case "hours":
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    case "day":
      return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
    case "month":
      return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }
}
