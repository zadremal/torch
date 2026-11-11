// Molecule: a summary tile — label, large value, note. `StatTileGrid` — a row of such
// tiles with a shared border: six on the session overview and six on the dashboard.
import { ErrorFilled } from "@carbon/icons-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import styles from "./StatTile.module.css";

export interface StatTileProps {
  label: string;
  /** Already formatted value. */
  value: string;
  /** Line under the value: delta against the previous period, explanation. */
  helper?: string;
  /** Error icon before the value: the Errors tile when there are errors. */
  error?: boolean;
  /** The tile is a link that shows or hides a block of the page: the session overview's Errors tile. */
  href?: string;
  /** With `href`: the block is shown, the tile is highlighted. */
  expanded?: boolean;
}

export function StatTile({ label, value, helper, error = false, href, expanded = false }: StatTileProps) {
  const content = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {error && <ErrorFilled size={24} className={styles.icon} aria-hidden="true" />}
        {value}
      </span>
      {helper && <span className={styles.helper}>{helper}</span>}
    </>
  );
  if (href === undefined) return <div className={styles.tile}>{content}</div>;
  return (
    <Link
      to={href}
      className={expanded ? `${styles.tile} ${styles.link} ${styles.expanded}` : `${styles.tile} ${styles.link}`}
      aria-expanded={expanded}
      preventScrollReset
    >
      {content}
    </Link>
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
