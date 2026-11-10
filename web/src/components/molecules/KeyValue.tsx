// Molecule: a "label — value" pair and a grid list of such pairs — the Basic information block
// in all detail panel views.
import type { ReactNode } from "react";
import styles from "./KeyValue.module.css";

export interface KeyValueProps {
  label: string;
  /** Value: text, `Mono`, a link to another panel item. */
  children: ReactNode;
  /** Value in the error color: the Errors row when there are errors. */
  error?: boolean;
}

export function KeyValue({ label, children, error = false }: KeyValueProps) {
  return (
    <div>
      <dt className={styles.label}>{label}</dt>
      <dd className={error ? `${styles.value} ${styles.valueError}` : styles.value}>
        {children}
      </dd>
    </div>
  );
}

/** List of pairs; the children are `KeyValue`. */
export function KeyValueList({ children }: { children: ReactNode }) {
  return <dl className={styles.list}>{children}</dl>;
}
