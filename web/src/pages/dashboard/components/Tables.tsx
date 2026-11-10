// The artboard's "Tool calls by tool" and "Model calls by model" tables. The rows are prepared by model.ts;
// an error share above the threshold is highlighted with the error color.
import { Meter } from "../../../components/atoms/Meter.tsx";
import { Mono } from "../../../components/atoms/Mono.tsx";
import type { ModelRow, ToolRow } from "../model.ts";
import styles from "./Tables.module.css";

export function ToolsTable({ rows }: { rows: readonly ToolRow[] }) {
  return (
    <div className={styles.scroll}>
      <div role="table" aria-label="Tool calls by tool" className={`${styles.root} ${styles.tools}`}>
        <div role="row" className={`${styles.row} ${styles.rowHead}`}>
          <div role="columnheader" className={styles.cell}>
            Tool
          </div>
          <div role="columnheader" className={styles.cell}>
            Calls
          </div>
          <div role="columnheader" className={`${styles.cell} ${styles.cellNum}`}>
            Errors
          </div>
          <div role="columnheader" className={`${styles.cell} ${styles.cellNum}`}>
            Error rate
          </div>
        </div>
        {rows.map((row) => (
          <div role="row" key={row.name} className={styles.row}>
            <div role="cell" className={styles.cell}>
              <Mono size="md">{row.name}</Mono>
            </div>
            <div role="cell" className={`${styles.cell} ${styles.calls}`}>
              <span className={styles.meter}>
                <Meter ratio={row.callsRatio} track={false} />
              </span>
              <span>{row.calls}</span>
            </div>
            <div role="cell" className={`${styles.cell} ${styles.cellNum}`}>
              {row.errors}
            </div>
            <div
              role="cell"
              className={
                row.highRate
                  ? `${styles.cell} ${styles.cellNum} ${styles.cellError}`
                  : `${styles.cell} ${styles.cellNum}`
              }
            >
              {row.rate}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className={styles.empty}>No tool calls in this period</p>}
      </div>
    </div>
  );
}

export function ModelsTable({ rows }: { rows: readonly ModelRow[] }) {
  return (
    <div className={styles.scroll}>
      <div role="table" aria-label="Model calls by model" className={`${styles.root} ${styles.models}`}>
        <div role="row" className={`${styles.row} ${styles.rowHead}`}>
          <div role="columnheader" className={styles.cell}>
            Model
          </div>
          <div role="columnheader" className={`${styles.cell} ${styles.cellNum}`}>
            Calls
          </div>
          <div role="columnheader" className={`${styles.cell} ${styles.cellNum}`}>
            Tokens
          </div>
          <div role="columnheader" className={`${styles.cell} ${styles.cellNum}`}>
            Cost
          </div>
        </div>
        {rows.map((row) => (
          <div role="row" key={row.model} className={styles.row}>
            <div role="cell" className={styles.cell}>
              <Mono size="md">{row.model}</Mono>
            </div>
            <div role="cell" className={`${styles.cell} ${styles.cellNum}`}>
              {row.calls}
            </div>
            <div role="cell" className={`${styles.cell} ${styles.cellNum}`}>
              {row.tokens}
            </div>
            <div role="cell" className={`${styles.cell} ${styles.cellNum}`}>
              {row.cost}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className={styles.empty}>No model calls in this period</p>}
      </div>
    </div>
  );
}
