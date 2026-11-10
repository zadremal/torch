// List of all API routes (plan §8). Paths are API_ROUTES from the contract, handlers are the src/api modules.
import { Hono } from "hono";
import { API_ROUTES } from "../contracts/api.ts";
import type { ApiDeps, AppEnv } from "./context.ts";
import { getContentBody } from "./contents.ts";
import { getDashboard } from "./dashboard.ts";
import { streamEvents } from "./events.ts";
import { exportSession } from "./export.ts";
import { getAgent, getFile, getNetwork, getPrompt, getToolCall } from "./items.ts";
import { postLogs, postMetrics } from "./otlp.ts";
import { listProjects } from "./projects.ts";
import { getSession, listSessions } from "./sessions.ts";
import { getSettings, putSettings } from "./settings.ts";
import { getTimeline } from "./timeline.ts";

export function createApi(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", deps.db);
    c.set("config", deps.config);
    c.set("now", deps.now);
    await next();
  });

  app.get(API_ROUTES.dashboard, getDashboard);
  app.get(API_ROUTES.sessions, listSessions);
  app.get(API_ROUTES.projects, listProjects);
  app.get(API_ROUTES.session, getSession);
  app.get(API_ROUTES.sessionExport, exportSession);
  app.get(API_ROUTES.timeline, getTimeline);
  app.get(API_ROUTES.agent, getAgent);
  app.get(API_ROUTES.toolCall, getToolCall);
  app.get(API_ROUTES.prompt, getPrompt);
  app.get(API_ROUTES.file, getFile);
  app.get(API_ROUTES.network, getNetwork);
  app.get(API_ROUTES.content, getContentBody);
  app.get(API_ROUTES.events, streamEvents);
  app.get(API_ROUTES.settings, getSettings);
  app.put(API_ROUTES.settings, putSettings);
  app.post(API_ROUTES.otlpLogs, postLogs);
  app.post(API_ROUTES.otlpMetrics, postMetrics);

  return app;
}
