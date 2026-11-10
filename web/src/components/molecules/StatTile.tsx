// Molecule: a summary tile — label, large value, note. `StatTileGrid` — a row of such
// tiles with a shared border: six on the session overview and six on the dashboard.
import { ErrorFilled } from "@carbon/icons-react";
import type { ReactNode } from "react";
import "./StatTile.scss";

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
    <div className="torch-stat-tile">
      <span className="torch-stat-tile__label">{label}</span>
      <span className="torch-stat-tile__value">
        {error && <ErrorFilled size={24} className="torch-stat-tile__icon" aria-hidden="true" />}
        {value}
      </span>
      {helper && <span className="torch-stat-tile__helper">{helper}</span>}
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
    <section className="torch-stat-tiles" aria-label={label}>
      {children}
    </section>
  );
}
