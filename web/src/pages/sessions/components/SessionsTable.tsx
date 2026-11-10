// The session list table, as in the artboard: eight columns, sorting by header, an empty state.
// It sorts nothing itself: the row order is set by the server, the table shows the key and direction.
import { ErrorFilled } from "@carbon/icons-react";
import type { SessionListItem, SessionSortKey, SortDir } from "@contracts/api.ts";
import { Link } from "react-router";
import { Mono } from "../../../components/atoms/Mono.tsx";
import { DASH, formatCount, formatDateTime, formatDuration, formatMoney, formatTokens } from "../../../lib/format.ts";
import { sessionHref } from "../../../lib/routes.ts";
import "./SessionsTable.scss";

interface Column {
  key: SessionSortKey;
  label: string;
  numeric: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: "name", label: "Session", numeric: false },
  { key: "started", label: "Started", numeric: false },
  { key: "duration", label: "Duration", numeric: true },
  { key: "agents", label: "Agents", numeric: true },
  { key: "tokens", label: "Tokens", numeric: true },
  { key: "toolCalls", label: "Tool calls", numeric: true },
  { key: "errors", label: "Errors", numeric: true },
  { key: "cost", label: "Cost", numeric: true },
];

export interface SessionsTableProps {
  items: readonly SessionListItem[];
  sort: SessionSortKey;
  dir: SortDir;
  /** The database has no sessions at all with the chosen `temp`: the empty state says so, rather than blaming the filters. */
  noSessions: boolean;
  onSort: (key: SessionSortKey) => void;
}

export function SessionsTable({ items, sort, dir, noSessions, onSort }: SessionsTableProps) {
  return (
    <div className="torch-slist-table__scroll">
      <div role="table" aria-label="Sessions" className="torch-slist-table">
        <div role="row" className="torch-slist-table__row torch-slist-table__row--head">
          {COLUMNS.map((column) => {
            const active = column.key === sort;
            return (
              <div
                key={column.key}
                role="columnheader"
                aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
                className={cell(column.numeric)}
              >
                <button type="button" className="torch-slist-table__sort" onClick={() => onSort(column.key)}>
                  {column.label}
                  <span aria-hidden="true" className="torch-slist-table__arrow">
                    {active ? (dir === "asc" ? "↑" : "↓") : ""}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {items.map((item) => (
          <div role="row" key={item.id} className="torch-slist-table__row">
            <div role="cell" className="torch-slist-table__cell torch-slist-table__name">
              <Link className="torch-slist-table__link" to={sessionHref("session", item.id)}>
                {item.name}
              </Link>
              <Mono tone="helper">
                {item.id.slice(0, 8)}
                {item.project !== null && ` · ${item.project}`}
              </Mono>
            </div>
            <div role="cell" className="torch-slist-table__cell torch-slist-table__started">
              {formatDateTime(item.startedAt)}
            </div>
            <div role="cell" className={cell(true)} title="Active time">
              {formatDuration(item.activeMs)}
            </div>
            <div role="cell" className={cell(true)}>
              {formatCount(item.agents)}
            </div>
            <div role="cell" className={cell(true)}>
              {formatTokens(item.tokens)}
            </div>
            <div role="cell" className={cell(true)}>
              {formatCount(item.toolCalls)}
            </div>
            <div role="cell" className={cell(true)}>
              {item.errors > 0 ? (
                <span className="torch-slist-table__errors">
                  <ErrorFilled size={16} aria-hidden="true" />
                  {formatCount(item.errors)}
                </span>
              ) : (
                <span className="torch-slist-table__zero">0</span>
              )}
            </div>
            <div role="cell" className={cell(true)}>
              {item.costUsd === null ? DASH : formatMoney(item.costUsd)}
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="torch-slist-table__empty">
            {noSessions ? (
              <>
                <p className="torch-slist-table__empty-title">No sessions yet</p>
                <p className="torch-slist-table__empty-text">
                  Sessions appear here once torch has indexed your Claude Code history.
                </p>
              </>
            ) : (
              <>
                <p className="torch-slist-table__empty-title">No sessions match these filters</p>
                <p className="torch-slist-table__empty-text">Widen a range or clear the search to see more sessions.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const cell = (numeric: boolean) =>
  numeric ? "torch-slist-table__cell torch-slist-table__cell--num" : "torch-slist-table__cell";
