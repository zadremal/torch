// Template of the session pages: breadcrumbs, heading, Overview and Timeline tabs, and below them
// the page. Knows nothing about data (plan §9.4): the page passes it all the header content with
// the `SessionHeader` component.
//
//   function SessionOverviewPage() {
//     const { id } = useParams();
//     const { data } = useApi(() => api.session(id), [id]);
//     return (
//       <>
//         <SessionHeader title={data?.name} activeTab="overview" tabHrefs={…} breadcrumbs={…} />
//         <SessionContent>…overview blocks…</SessionContent>
//       </>
//     );
//   }
//
// `SessionHeader` is rendered by a portal into the template's header place. Until the page has rendered it
// (placeholder, first render), the template shows the same header without data.
import { Breadcrumb, BreadcrumbItem, SkeletonText } from "@carbon/react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { Link, Outlet, useOutletContext } from "react-router";
import styles from "./SessionLayout.module.css";

export type SessionTab = "overview" | "timeline";

export interface SessionCrumb {
  label: string;
  /** Without an address — the current page, last in the chain. */
  href?: string;
}

export interface SessionHeaderProps {
  /** Session name; until it is loaded — a placeholder in place of the heading. */
  title?: string;
  breadcrumbs?: SessionCrumb[];
  activeTab?: SessionTab;
  /** Tab addresses; without them the tabs lead nowhere. */
  tabHrefs?: Record<SessionTab, string>;
  /** Line under the heading: status, project, time, model, enrichment note. */
  meta?: ReactNode;
  /** Buttons to the right of the heading: Export JSON, Open timeline. */
  actions?: ReactNode;
  /** Header at the width of the timeline page; otherwise — the width of the content area. */
  wide?: boolean;
}

const TABS: { tab: SessionTab; label: string }[] = [
  { tab: "overview", label: "Overview" },
  { tab: "timeline", label: "Timeline" },
];

/** The header place in the template: `SessionHeader` of the page receives it. */
type HeaderSlot = HTMLElement | null;

function HeaderContent({ title, breadcrumbs = [], activeTab, tabHrefs, meta, actions, wide = false }: SessionHeaderProps) {
  return (
    <div className={wide ? `${styles.head} ${styles.headWide}` : styles.head}>
      {breadcrumbs.length > 0 && (
        <Breadcrumb noTrailingSlash aria-label="Breadcrumb">
          {breadcrumbs.map((crumb) =>
            crumb.href ? (
              <BreadcrumbItem key={crumb.label}>
                <Link to={crumb.href}>{crumb.label}</Link>
              </BreadcrumbItem>
            ) : (
              <BreadcrumbItem key={crumb.label} isCurrentPage>
                {crumb.label}
              </BreadcrumbItem>
            ),
          )}
        </Breadcrumb>
      )}
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          {title === undefined ? (
            <SkeletonText heading className={styles.titleSkeleton} />
          ) : (
            <h1 className={styles.title}>{title}</h1>
          )}
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <nav aria-label="Session views" className={styles.tabs}>
        {TABS.map(({ tab, label }) =>
          tabHrefs ? (
            <Link
              key={tab}
              to={tabHrefs[tab]}
              className={styles.tab}
              aria-current={tab === activeTab ? "page" : undefined}
            >
              {label}
            </Link>
          ) : (
            <span key={tab} className={styles.tab} aria-current={tab === activeTab ? "page" : undefined}>
              {label}
            </span>
          ),
        )}
        <span className={styles.tabsRest} />
      </nav>
    </div>
  );
}

export function SessionLayout() {
  const [slot, setSlot] = useState<HeaderSlot>(null);
  return (
    <div className={styles.root}>
      <div ref={setSlot} className={styles.slot} />
      {/* Hidden by the styles as soon as the page header has appeared in the header place. */}
      <div className={styles.placeholder} aria-hidden="true">
        <HeaderContent />
      </div>
      <Outlet context={slot satisfies HeaderSlot} />
    </div>
  );
}

/** Session header: the page gives the template the heading, crumbs, active tab and its own insertions. */
export function SessionHeader(props: SessionHeaderProps) {
  const slot = useOutletContext<HeaderSlot>();
  return slot ? createPortal(<HeaderContent {...props} />, slot) : null;
}

/** Column of blocks under the header at the width of the content area: the session overview. */
export function SessionContent({ children }: { children: ReactNode }) {
  return <div className={styles.content}>{children}</div>;
}
