// Molecule: a screen block — a second-level heading, a note on the right and the content.
// Session overview, dashboard, detail panel.
import type { ReactNode } from "react";
import "./Section.scss";

export interface SectionProps {
  id: string;
  title: string;
  aside?: string;
  children: ReactNode;
}

export function Section({ id, title, aside, children }: SectionProps) {
  return (
    <section aria-labelledby={id} className="torch-section">
      <div className="torch-section__head">
        <h2 id={id} className="torch-section__title">
          {title}
        </h2>
        {aside && <span className="torch-section__aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
