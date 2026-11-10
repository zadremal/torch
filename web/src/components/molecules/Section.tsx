// Molecule: a screen block — a second-level heading, a note on the right and the content.
// Session overview, dashboard, detail panel (the `panel` variant).
import type { ReactNode } from "react";
import styles from "./Section.module.css";

export interface SectionProps {
  id: string;
  title: string;
  aside?: string;
  /** `panel` — a block of the detail panel: 14px heading and a bottom border, as in the artboard. */
  variant?: "page" | "panel";
  children: ReactNode;
}

export function Section({ id, title, aside, variant = "page", children }: SectionProps) {
  return (
    <section aria-labelledby={id} className={variant === "panel" ? `${styles.root} ${styles.panel}` : styles.root}>
      <div className={styles.head}>
        <h2 id={id} className={styles.title}>
          {title}
        </h2>
        {aside && <span className={styles.aside}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}
