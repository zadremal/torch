// Molecule: a "label — value" pair and a grid list of such pairs — the Basic information block
// in all detail panel views.
import type { ReactNode } from "react";
import "./KeyValue.scss";

export interface KeyValueProps {
  label: string;
  /** Value: text, `Mono`, a link to another panel item. */
  children: ReactNode;
  /** Value in the error color: the Errors row when there are errors. */
  error?: boolean;
}

export function KeyValue({ label, children, error = false }: KeyValueProps) {
  return (
    <div className="torch-key-value">
      <dt className="torch-key-value__label">{label}</dt>
      <dd className={error ? "torch-key-value__value torch-key-value__value--error" : "torch-key-value__value"}>
        {children}
      </dd>
    </div>
  );
}

/** List of pairs; the children are `KeyValue`. */
export function KeyValueList({ children }: { children: ReactNode }) {
  return <dl className="torch-key-value-list">{children}</dl>;
}
