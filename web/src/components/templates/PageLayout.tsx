// Template of an ordinary page inside AppShell: heading, note, a place for controls on the right
// and a column of blocks. Dashboard and Sessions are built this way in the mockups; Settings uses the same.
import type { ReactNode } from "react";
import "./PageLayout.scss";

export interface PageLayoutProps {
  title: string;
  description?: ReactNode;
  /** Place to the right of the heading: the dashboard range. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function PageLayout({ title, description, actions, children }: PageLayoutProps) {
  return (
    <div className="torch-page">
      <div className="torch-page__header">
        <div className="torch-page__heading">
          <h1 className="torch-page__title">{title}</h1>
          {description && <p className="torch-page__description">{description}</p>}
        </div>
        {actions && <div className="torch-page__actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
