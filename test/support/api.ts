// A test-based API: the app from routes.ts and a request with response parsing.
//
//   const api = testApi(db);
//   const body = await api.get<SessionsResponse>("/api/sessions?sort=cost");
import type { Database } from "bun:sqlite";
import { createApi } from "../../src/api/routes.ts";
import { loadConfig, type TorchConfig } from "../../src/config.ts";

const ROOT = "/tmp/torch-test";

/** API test configuration: all paths are in a temporary directory, tests do not read the real Claude Code directories. */
export function testConfig(): TorchConfig {
  return loadConfig({ dataDir: ROOT, transcriptsDir: `${ROOT}/projects`, desktopSessionsDir: `${ROOT}/desktop`, claudeSettingsPath: `${ROOT}/settings.json` });
}

export function testApi(db: Database, now: () => number = () => 0) {
  const app = createApi({ db, config: testConfig(), now });
  return {
    app,
    request: (path: string) => app.request(path),
    /** A 200 response as an object; any other code is an error with the code and the body. */
    async get<T>(path: string): Promise<T> {
      const response = await app.request(path);
      if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    },
  };
}
