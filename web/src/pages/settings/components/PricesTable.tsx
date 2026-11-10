// The prices table: a row per model, cells are edited in place. The draft state is held by the page.
import { Button, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import { type DraftRow, type PriceField, PRICE_COLUMNS } from "../model.ts";
import styles from "./PricesTable.module.css";

export interface PricesTableProps {
  rows: readonly DraftRow[];
  /** Parse error by row key. */
  errors: ReadonlyMap<number, string>;
  onModelChange: (key: number, model: string) => void;
  onCellChange: (key: number, field: PriceField, value: string) => void;
  onRemove: (key: number) => void;
  onAdd: () => void;
}

export function PricesTable({ rows, errors, onModelChange, onCellChange, onRemove, onAdd }: PricesTableProps) {
  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <table className={styles.table} aria-label="Prices per million tokens">
          <thead>
            <tr>
              <th scope="col">Model</th>
              {PRICE_COLUMNS.map(({ field, label }) => (
                <th scope="col" key={field}>
                  {label}
                </th>
              ))}
              <th scope="col">
                <span className={styles.sr}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const error = errors.get(row.key);
              const name = row.model || "new model";
              return (
                <tr key={row.key}>
                  <td>
                    <TextInput
                      id={`price-${row.key}-model`}
                      size="sm"
                      labelText={`Model name, ${name}`}
                      hideLabel
                      value={row.model}
                      invalid={error !== undefined && !error.includes(" must be ")}
                      invalidText={error}
                      onChange={(e) => onModelChange(row.key, e.target.value)}
                    />
                  </td>
                  {PRICE_COLUMNS.map(({ field, label }) => (
                    <td key={field}>
                      <TextInput
                        id={`price-${row.key}-${field}`}
                        size="sm"
                        inputMode="decimal"
                        labelText={`${label}, ${name}`}
                        hideLabel
                        value={row.cells[field]}
                        invalid={error !== undefined && error.startsWith(label)}
                        invalidText={error}
                        onChange={(e) => onCellChange(row.key, field, e.target.value)}
                      />
                    </td>
                  ))}
                  <td>
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={TrashCan}
                      iconDescription={`Remove ${name}`}
                      tooltipPosition="left"
                      onClick={() => onRemove(row.key)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button kind="tertiary" size="md" renderIcon={Add} onClick={onAdd}>
        Add model
      </Button>
    </div>
  );
}
