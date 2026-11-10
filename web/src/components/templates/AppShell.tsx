// Template: header and content area. The layout of all pages except the panel in a separate tab.
// Knows nothing about data: the router supplies the page.
import { Outlet } from "react-router";
import { AppHeader } from "../organisms/AppHeader/AppHeader.tsx";
import styles from "./AppShell.module.css";

export function AppShell() {
  return (
    <div className={styles.root}>
      <AppHeader />
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
