// Agents table: nested subagents indented by depth.
import { Link } from "react-router";
import { Meter } from "../../../components/atoms/Meter.tsx";
import { Mono } from "../../../components/atoms/Mono.tsx";
import type { AgentRowModel } from "../model.ts";
import styles from "./AgentsTable.module.css";

export interface AgentsTableProps {
  rows: AgentRowModel[];
  /** Address of this session's Timeline tab. */
  timelineHref: string;
}

export function AgentsTable({ rows, timelineHref }: AgentsTableProps) {
  return (
    <div className={styles.root}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Model</th>
            <th scope="col">Peak context</th>
            <th scope="col" className={styles.num}>
              Run duration
            </th>
            <th scope="col">Tool usage</th>
            <th scope="col" className={styles.num}>
              Files read
            </th>
            <th scope="col" className={styles.num}>
              Errors
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agentId}>
              <td>
                <div
                  className={styles.name}
                  data-depth={row.depth}
                  style={{ paddingInlineStart: `calc(${row.depth} * 1.5rem)` }}
                >
                  <Link to={timelineHref}>{row.name}</Link>
                  <Mono tone="helper">{row.caption}</Mono>
                </div>
              </td>
              <td>{row.model ? <Mono tone="primary">{row.model}</Mono> : "—"}</td>
              <td>
                {row.peak}
                {row.peakRatio !== null && <Meter ratio={row.peakRatio} />}
              </td>
              <td className={styles.num}>{row.runDuration}</td>
              <td>
                {row.calls}
                {row.usage && (
                  <div>
                    <Mono tone="helper">{row.usage}</Mono>
                  </div>
                )}
              </td>
              <td className={styles.num}>{row.filesRead}</td>
              <td
                className={
                  row.errors > 0
                    ? `${styles.num} ${styles.numError}`
                    : `${styles.num} ${styles.numZero}`
                }
              >
                {row.errors}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
