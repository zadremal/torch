// Template of an ordinary page inside AppShell: heading, note, a place for controls on the right
// and a column of blocks. Dashboard and Sessions are built this way in the mockups; Settings uses the same.
import type { ReactNode } from "react";
import styles from "./PageLayout.module.css";

export interface PageLayoutProps {
  title: string;
  description?: ReactNode;
  /** Place to the right of the heading: the dashboard range. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function PageLayout({ title, description, actions, children }: PageLayoutProps) {
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}
