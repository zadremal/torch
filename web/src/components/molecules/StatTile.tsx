// Molecule: a summary tile — label, large value, note. `StatTileGrid` — a row of such
// tiles with a shared border: six on the session overview and six on the dashboard.
import { ErrorFilled } from "@carbon/icons-react";
import type { ReactNode } from "react";
import styles from "./StatTile.module.css";

export interface StatTileProps {
  label: string;
  /** Already formatted value. */
  value: string;
  /** Line under the value: delta against the previous period, explanation. */
  helper?: string;
  /** Error icon before the value: the Errors tile when there are errors. */
  error?: boolean;
}

export function StatTile({ label, value, helper, error = false }: StatTileProps) {
  return (
    <div className={styles.tile}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {error && <ErrorFilled size={24} className={styles.icon} aria-hidden="true" />}
        {value}
      </span>
      {helper && <span className={styles.helper}>{helper}</span>}
    </div>
  );
}

export interface StatTileGridProps {
  /** Block name for assistive technologies: "Session summary", "Totals". */
  label: string;
  children: ReactNode;
}

export function StatTileGrid({ label, children }: StatTileGridProps) {
  return (
    <section className={styles.tiles} aria-label={label}>
      {children}
    </section>
  );
}
