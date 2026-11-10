// UI routes (plan §9.1): the single place for page paths and address building.

export const ROUTES = {
  dashboard: "/",
  sessions: "/sessions",
  session: "/sessions/:id",
  timeline: "/sessions/:id/timeline",
  panel: "/sessions/:id/panel",
  settings: "/settings",
} as const;

export type RouteName = keyof typeof ROUTES;

/** Session page address: overview, timeline, or a panel in a separate tab. */
export function sessionHref(route: "session" | "timeline" | "panel", id: string): string {
  return ROUTES[route].replace(":id", encodeURIComponent(id));
}
