// Errors list: the session's failed tool calls by time. A row opens the call in the details panel.
import { Link } from "react-router";
import { Mono } from "../../../components/atoms/Mono.tsx";
import type { ErrorRowModel } from "../model.ts";
import styles from "./ErrorsTable.module.css";

export interface ErrorsTableProps {
  rows: ErrorRowModel[];
  /** Address that opens the call in the details panel beside the overview. */
  errorHref: (callId: string) => string;
  /** The call shown in the details panel: its row is highlighted. */
  selectedCallId?: string;
}

export function ErrorsTable({ rows, errorHref, selectedCallId }: ErrorsTableProps) {
  return (
    <div className={styles.root}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Agent</th>
            <th scope="col">Time</th>
            <th scope="col">Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = row.id === selectedCallId;
            return (
              <tr key={row.id} className={selected ? styles.selected : undefined}>
                <td>
                  <div className={styles.tool}>
                    {/* The link covers the whole row (::after), so a click anywhere in it opens the call. */}
                    <Link
                      to={errorHref(row.id)}
                      className={styles.open}
                      aria-current={selected ? "true" : undefined}
                      preventScrollReset
                    >
                      <Mono>{row.tool}</Mono>
                    </Link>
                    {row.target && (
                      <Mono tone="helper" truncate title={row.target}>
                        {row.target}
                      </Mono>
                    )}
                  </div>
                </td>
                <td>
                  {row.agent}
                  {row.agent !== row.agentId && (
                    <div>
                      <Mono tone="helper">{row.agentId}</Mono>
                    </div>
                  )}
                </td>
                <td className={styles.time}>
                  {row.time}
                  {row.offset && (
                    <div>
                      <Mono tone="helper">{row.offset}</Mono>
                    </div>
                  )}
                </td>
                <td>
                  <span className={styles.error} title={row.error}>
                    <Mono>{row.error}</Mono>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
