// Hono app assembly: the API from routes.ts and serving of the built UI. Package I4.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { notFound, type ApiDeps, type AppEnv } from "./api/context.ts";
import { createApi } from "./api/routes.ts";
import { API_ROUTES, type ApiError } from "./contracts/api.ts";

/** Where `bun run build` puts the built UI. */
export const WEB_DIST = fileURLToPath(new URL("../web/dist", import.meta.url));

/** Addresses at which torch is reachable only from this machine. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];
/** The same addresses as they arrive in the `Host` header (without the port). */
const LOOPBACK_HOST_HEADERS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

const TOKEN_PARAM = "token";
const TOKEN_COOKIE = "torch_token";

/** First path segments of the API: an unknown path under them is a 404, not a UI page. */
const API_PREFIXES = [...new Set(Object.values(API_ROUTES).map((route) => `/${route.split("/")[1]}/`))];

export interface ServerOptions {
  /** Directory of the built UI; `web/dist` by default. */
  webDir?: string;
  /** If set, every request must present it (decision 17). Without it the server answers only at this machine's addresses. */
  token?: string | null;
}

/** Access token for an address open to the outside; not needed for this machine's addresses — null. */
export function accessToken(host: string): string | null {
  return LOOPBACK_HOSTS.includes(host) ? null : randomBytes(24).toString("base64url");
}

function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Path for a redirect within this server: anything a browser would read as another address is reduced to the root. */
function localPath(pathname: string): string {
  return pathname.startsWith("/") && !pathname.startsWith("//") && !pathname.includes("\\") ? pathname : "/";
}

/**
 * Lets a request through with the token in a cookie. The token from the address printed by `torch start` is swapped
 * for a cookie by a redirect: it does not remain in the browser history or in links.
 */
function requireToken(token: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (sameToken(c.req.query(TOKEN_PARAM), token)) {
      setCookie(c, TOKEN_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/" });
      const url = new URL(c.req.url);
      url.searchParams.delete(TOKEN_PARAM);
      return c.redirect(`${localPath(url.pathname)}${url.search}`);
    }
    if (sameToken(getCookie(c, TOKEN_COOKIE), token)) return next();
    return c.json<ApiError>({ error: "Access token required: open the address printed by the torch start command" }, 401);
  };
}

/**
 * Without a token the server listens only on this machine, and a request must be addressed to it. A foreign name in
 * `Host` is a sign of DNS rebinding: a page of an outside site would read prompts and outputs from the database.
 */
const requireLoopbackHost: MiddlewareHandler<AppEnv> = async (c, next) => {
  let hostname: string | null = null;
  try {
    hostname = new URL(`http://${c.req.header("host") ?? new URL(c.req.url).host}`).hostname;
  } catch {
    // A header that does not parse as an address does not count as ours.
  }
  if (hostname !== null && LOOPBACK_HOST_HEADERS.includes(hostname)) return next();
  return c.json<ApiError>({ error: "Request is not addressed to this machine" }, 403);
};

/** Built UI file by request path; null if there is no such file or the path leads outside the directory. */
function webFile(webDir: string, pathname: string): Blob | null {
  try {
    // Real paths: a symbolic link inside the build does not lead outside its directory.
    const root = realpathSync(webDir);
    const path = realpathSync(resolve(root, `.${decodeURIComponent(pathname)}`));
    return path.startsWith(root + sep) && statSync(path).isFile() ? Bun.file(path) : null;
  } catch {
    // No build, no such file, or the path does not decode.
    return null;
  }
}

export function createServer(deps: ApiDeps, options: ServerOptions = {}): Hono<AppEnv> {
  const webDir = options.webDir ?? WEB_DIST;
  const app = new Hono<AppEnv>();
  app.use(options.token ? requireToken(options.token) : requireLoopbackHost);
  app.route("/", createApi(deps));

  app.get("*", (c) => {
    const path = c.req.path;
    if (API_PREFIXES.some((prefix) => path.startsWith(prefix))) return notFound(c, path);
    // UI routes (plan §9.1) are parsed by the UI itself: a path without an extension is a page.
    const isPage = !/\.[^/]+$/.test(path);
    const file = webFile(webDir, path) ?? (isPage ? webFile(webDir, "/index.html") : null);
    if (file) return new Response(file);
    if (isPage) return c.text("UI is not built: run `bun run build`.", 503);
    return c.notFound();
  });

  return app;
}
