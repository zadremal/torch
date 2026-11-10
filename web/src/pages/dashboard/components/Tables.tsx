// The artboard's "Tool calls by tool" and "Model calls by model" tables. The rows are prepared by model.ts;
// an error share above the threshold is highlighted with the error color.
import { Meter } from "../../../components/atoms/Meter.tsx";
import { Mono } from "../../../components/atoms/Mono.tsx";
import type { ModelRow, ToolRow } from "../model.ts";
import "./Tables.scss";

export function ToolsTable({ rows }: { rows: readonly ToolRow[] }) {
  return (
    <div className="torch-dash-table__scroll">
      <div role="table" aria-label="Tool calls by tool" className="torch-dash-table torch-dash-table--tools">
        <div role="row" className="torch-dash-table__row torch-dash-table__row--head">
          <div role="columnheader" className="torch-dash-table__cell">
            Tool
          </div>
          <div role="columnheader" className="torch-dash-table__cell">
            Calls
          </div>
          <div role="columnheader" className="torch-dash-table__cell torch-dash-table__cell--num">
            Errors
          </div>
          <div role="columnheader" className="torch-dash-table__cell torch-dash-table__cell--num">
            Error rate
          </div>
        </div>
        {rows.map((row) => (
          <div role="row" key={row.name} className="torch-dash-table__row">
            <div role="cell" className="torch-dash-table__cell">
              <Mono size="md">{row.name}</Mono>
            </div>
            <div role="cell" className="torch-dash-table__cell torch-dash-table__calls">
              <span className="torch-dash-table__meter">
                <Meter ratio={row.callsRatio} track={false} />
              </span>
              <span>{row.calls}</span>
            </div>
            <div role="cell" className="torch-dash-table__cell torch-dash-table__cell--num">
              {row.errors}
            </div>
            <div
              role="cell"
              className={
                row.highRate
                  ? "torch-dash-table__cell torch-dash-table__cell--num torch-dash-table__cell--error"
                  : "torch-dash-table__cell torch-dash-table__cell--num"
              }
            >
              {row.rate}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="torch-dash-table__empty">No tool calls in this period</p>}
      </div>
    </div>
  );
}

export function ModelsTable({ rows }: { rows: readonly ModelRow[] }) {
  return (
    <div className="torch-dash-table__scroll">
      <div role="table" aria-label="Model calls by model" className="torch-dash-table torch-dash-table--models">
        <div role="row" className="torch-dash-table__row torch-dash-table__row--head">
          <div role="columnheader" className="torch-dash-table__cell">
            Model
          </div>
          <div role="columnheader" className="torch-dash-table__cell torch-dash-table__cell--num">
            Calls
          </div>
          <div role="columnheader" className="torch-dash-table__cell torch-dash-table__cell--num">
            Tokens
          </div>
          <div role="columnheader" className="torch-dash-table__cell torch-dash-table__cell--num">
            Cost
          </div>
        </div>
        {rows.map((row) => (
          <div role="row" key={row.model} className="torch-dash-table__row">
            <div role="cell" className="torch-dash-table__cell">
              <Mono size="md">{row.model}</Mono>
            </div>
            <div role="cell" className="torch-dash-table__cell torch-dash-table__cell--num">
              {row.calls}
            </div>
            <div role="cell" className="torch-dash-table__cell torch-dash-table__cell--num">
              {row.tokens}
            </div>
            <div role="cell" className="torch-dash-table__cell torch-dash-table__cell--num">
              {row.cost}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="torch-dash-table__empty">No model calls in this period</p>}
      </div>
    </div>
  );
}
