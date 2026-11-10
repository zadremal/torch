// The page switcher under the table; with a single page it renders nothing.
import { Button } from "@carbon/react";
import { pageCount } from "../query.ts";
import styles from "./SessionsPager.module.css";

export interface SessionsPagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

export function SessionsPager({ page, pageSize, total, onPage }: SessionsPagerProps) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className={styles.root}>
      <span className={styles.status}>
        Page {page} of {pages}
      </span>
      <Button kind="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <Button kind="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
