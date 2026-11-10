// UI router: the six routes of plan §9.1. Paths live in lib/routes.ts.
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { AppShell } from "./components/templates/AppShell.tsx";
import { SessionLayout } from "./components/templates/SessionLayout.tsx";
import { ROUTES } from "./lib/routes.ts";
import { DashboardPage } from "./pages/dashboard/DashboardPage.tsx";
import { PanelPage } from "./pages/panel/PanelPage.tsx";
import { SessionOverviewPage } from "./pages/session-overview/SessionOverviewPage.tsx";
import { SessionTimelinePage } from "./pages/session-timeline/SessionTimelinePage.tsx";
import { SessionsPage } from "./pages/sessions/SessionsPage.tsx";
import { SettingsPage } from "./pages/settings/SettingsPage.tsx";

// Showcase of the shared components on examples from dto: development mode only, not part of the build.
// Temporary: removed together with the src/dev directory once screens W2–W7 show these components themselves.
const DevComponents = import.meta.env.DEV
  ? lazy(() => import("./dev/Showcase.tsx").then((m) => ({ default: m.ComponentsShowcase })))
  : null;
const DevSession = import.meta.env.DEV
  ? lazy(() => import("./dev/Showcase.tsx").then((m) => ({ default: m.SessionShowcase })))
  : null;

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path={ROUTES.dashboard} element={<DashboardPage />} />
        <Route path={ROUTES.sessions} element={<SessionsPage />} />
        <Route element={<SessionLayout />}>
          <Route path={ROUTES.session} element={<SessionOverviewPage />} />
          <Route path={ROUTES.timeline} element={<SessionTimelinePage />} />
          {DevSession && (
            <Route
              path="/dev/session"
              element={
                <Suspense>
                  <DevSession />
                </Suspense>
              }
            />
          )}
        </Route>
        <Route path={ROUTES.settings} element={<SettingsPage />} />
        {DevComponents && (
          <Route
            path="/dev/showcase"
            element={
              <Suspense>
                <DevComponents />
              </Suspense>
            }
          />
        )}
      </Route>
      <Route path={ROUTES.panel} element={<PanelPage />} />
    </Routes>
  );
}
