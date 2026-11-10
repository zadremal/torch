// Template: header and content area. The layout of all pages except the panel in a separate tab.
// Knows nothing about data: the router supplies the page.
import { Outlet } from "react-router";
import { AppHeader } from "../organisms/AppHeader/AppHeader.tsx";
import "./AppShell.scss";

export function AppShell() {
  return (
    <div className="torch-shell">
      <AppHeader />
      <main className="torch-shell__main">
        <Outlet />
      </main>
    </div>
  );
}
