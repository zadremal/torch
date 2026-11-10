// Server: routes from routes.ts, serving of the built UI, a token for an address open to the outside.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { API_ROUTES, type ApiError, type SessionsResponse } from "../src/contracts/api.ts";
import { openMemoryDb } from "../src/db/db.ts";
import { accessToken, createServer, WEB_DIST, type ServerOptions } from "../src/server.ts";
import { REF_NAME, REF_SESSION_ID, REF_START } from "./support/reference.ts";
import { seedReference } from "./support/reference-seed.ts";

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

/** Directory with the built UI: a page and two build files. Next to it is a file that must not be served. */
function builtWeb(): string {
  const root = mkdtempSync(join(tmpdir(), "torch-server-"));
  const files: Record<string, string> = {
    "dist/index.html": INDEX_HTML,
    "dist/assets/app.js": "console.log('torch')",
    "dist/assets/app.css": "body { margin: 0 }",
    "secret.txt": "outside the build",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return join(root, "dist");
}

function server(options: ServerOptions = {}) {
  const db = openMemoryDb();
  seedReference(db);
  // All directories are temporary: in tests the server does not reach the real history.
  const home = mkdtempSync(join(tmpdir(), "torch-server-home-"));
  const config = loadConfig({ dataDir: join(home, "torch"), transcriptsDir: join(home, "projects"), desktopSessionsDir: join(home, "desktop"), claudeSettingsPath: join(home, "settings.json") });
  return createServer({ db, config, now: () => REF_START + 3_600_000 }, { webDir: builtWeb(), ...options });
}

test("routes from routes.ts work through the server", async () => {
  const app = server();

  const response = await app.request("/api/sessions");
  expect(response.status).toBe(200);
  expect(((await response.json()) as SessionsResponse).items.map((item) => [item.id, item.name])).toEqual([[REF_SESSION_ID, REF_NAME]]);

  for (const [name, route] of Object.entries(API_ROUTES)) {
    const reply = await app.request(route.replace(/:\w+/g, "x"), { method: name.startsWith("otlp") ? "POST" : "GET" });
    // The handler answered JSON (including a 501 stub and "not found") or an event stream, not a UI page.
    const expected = name === "events" ? "text/event-stream" : "json";
    expect({ name, api: reply.headers.get("content-type")?.includes(expected) ?? false }).toEqual({ name, api: true });
    // The event stream does not end by itself: the client closes the connection.
    await reply.body?.cancel();
  }
});

test("the root serves the built UI page", async () => {
  const response = await server().request("/");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toBe(INDEX_HTML);
});

test("build files are served with their own content type", async () => {
  const app = server();

  const script = await app.request("/assets/app.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(await script.text()).toBe("console.log('torch')");

  const styles = await app.request("/assets/app.css");
  expect(styles.headers.get("content-type")).toContain("text/css");
});

test("UI routes (plan §9.1) serve the same page: the UI itself parses them", async () => {
  const app = server();

  for (const path of ["/sessions", `/sessions/${REF_SESSION_ID}`, `/sessions/${REF_SESSION_ID}/timeline?sel=tool:toolu_1&dock=left`, `/sessions/${REF_SESSION_ID}/panel`, "/settings"]) {
    const response = await app.request(path);
    expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 200, body: INDEX_HTML });
  }
});

test("a nonexistent build file — 404, not the page", async () => {
  const response = await server().request("/assets/missing.js");

  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("<html");
});

test("an unknown path under /api and /otlp — 404 in JSON, not the page", async () => {
  const app = server();

  for (const path of ["/api/nope", "/api/sessions/x/unknown", "/otlp/v1/traces"]) {
    const response = await app.request(path);
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
    expect(((await response.json()) as ApiError).error).toContain(path);
  }
});

test("a path leading outside the build directory is not served", async () => {
  const app = server();

  for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/assets/%00.js", "/%E0%A4%A.txt"]) {
    const response = await app.request(path);
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
    expect(await response.text()).not.toContain("outside the build");
  }
});

test("a symbolic link inside the build does not lead outside its directory", async () => {
  const webDir = builtWeb();
  symlinkSync(join(webDir, "..", "secret.txt"), join(webDir, "assets", "leak.txt"));
  symlinkSync(join(webDir, ".."), join(webDir, "up"));
  // A link inside the build directory stays working.
  symlinkSync(join(webDir, "assets", "app.js"), join(webDir, "assets", "alias.js"));
  const app = server({ webDir });

  for (const path of ["/assets/leak.txt", "/up/secret.txt"]) {
    const response = await app.request(path);
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
    expect(await response.text()).not.toContain("outside the build");
  }
  expect(await (await app.request("/assets/alias.js")).text()).toBe("console.log('torch')");
});

test("the default build directory is the repository's web/dist, where bun run build builds", () => {
  expect(WEB_DIST).toBe(join(import.meta.dir, "..", "web", "dist"));
});

test("UI not built: the page answers 503 with a hint, the API works", async () => {
  const app = server({ webDir: join(tmpdir(), "torch-server-no-build") });

  const page = await app.request("/sessions");
  expect(page.status).toBe(503);
  expect(await page.text()).toContain("bun run build");
  expect((await app.request("/api/sessions")).status).toBe(200);
});

test("without a token the server answers only requests addressed to this machine (DNS rebinding protection)", async () => {
  const app = server();

  for (const host of ["127.0.0.1", "127.0.0.1:4820", "localhost", "localhost:4820", "[::1]", "[::1]:4820", "LOCALHOST:4820"]) {
    const response = await app.request("/api/sessions", { headers: { host } });
    expect({ host, status: response.status }).toEqual({ host, status: 200 });
  }
  for (const host of ["evil.example", "evil.example:4820", "localhost.evil.example", "127.0.0.1.evil.example:4820", "192.168.1.20:4820", "0.0.0.0:4820", "localhost:4820@evil.example", ""]) {
    for (const path of ["/api/sessions", "/", "/assets/app.js"]) {
      const response = await app.request(path, { headers: { host } });
      expect({ host, path, status: response.status }).toEqual({ host, path, status: 403 });
      expect(await response.text()).not.toContain(REF_NAME);
    }
  }
});

test("with a token the name in Host is not restricted: the server is open to the outside, the token gives access", async () => {
  const app = server({ token: "s3cret-token" });

  const response = await app.request("/api/sessions", { headers: { host: "torch.lan:4820", cookie: "torch_token=s3cret-token" } });

  expect(response.status).toBe(200);
});

test("a token is needed only for an address open to the outside", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) expect(accessToken(host)).toBeNull();

  const token = accessToken("0.0.0.0")!;
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(accessToken("192.168.1.20")).not.toBe(token);
});

test("with a token: without it 401 both on the page and in the API", async () => {
  const app = server({ token: "s3cret-token" });

  for (const path of ["/", "/api/sessions", "/assets/app.js", "/?token=wrong", "/api/sessions?token="]) {
    const response = await app.request(path);
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
    expect(await response.text()).not.toContain(REF_NAME);
  }
  expect((await app.request("/api/sessions", { headers: { cookie: "torch_token=wrong" } })).status).toBe(401);
});

test("with a token: the address from torch start swaps the token for a cookie, then requests pass by it", async () => {
  const app = server({ token: "s3cret-token" });

  const entry = await app.request(`/sessions/${REF_SESSION_ID}/timeline?token=s3cret-token&zoom=2`);
  expect(entry.status).toBe(302);
  // The token does not remain in the address.
  expect(entry.headers.get("location")).toBe(`/sessions/${REF_SESSION_ID}/timeline?zoom=2`);
  const cookie = entry.headers.get("set-cookie")!;
  expect(cookie).toContain("torch_token=s3cret-token");
  expect(cookie).toContain("HttpOnly");

  const headers = { cookie: cookie.split(";")[0]! };
  expect((await app.request("/api/sessions", { headers })).status).toBe(200);
  expect(await (await app.request("/", { headers })).text()).toBe(INDEX_HTML);
});

test("the redirect after the token swap leads only to a path of this server", async () => {
  const app = server({ token: "s3cret-token" });

  // A path that a browser would read as another site's address is reduced to the root.
  for (const target of ["//evil.example/x", "//evil.example", "/\\evil.example/x", "///evil.example"]) {
    const response = await app.request(new Request(`http://torch.lan:4820${target}?token=s3cret-token&zoom=2`));
    expect({ target, status: response.status, location: response.headers.get("location") }).toEqual({ target, status: 302, location: "/?zoom=2" });
  }
  // A request with an absolute address in the request line: only the path remains.
  const absolute = await app.request(new Request("http://evil.example/sessions?token=s3cret-token"));
  expect(absolute.headers.get("location")).toBe("/sessions");
});

test("without a token (this machine's address) requests pass as is", async () => {
  expect((await server({ token: null }).request("/api/sessions")).status).toBe(200);
});
