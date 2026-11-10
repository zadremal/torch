import { expect, test } from "bun:test";
import { API_ROUTES } from "../../src/contracts/api.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { createApi } from "../../src/api/routes.ts";
import { testConfig } from "../support/api.ts";

const app = createApi({ db: openMemoryDb(), config: testConfig(), now: () => 0 });
const path = (route: string) => route.replace(/:\w+/g, "x");

test("every route from API_ROUTES is registered", async () => {
  for (const [name, route] of Object.entries(API_ROUTES)) {
    const method = name.startsWith("otlp") ? "POST" : "GET";
    const response = await app.request(path(route), { method });
    // A stub answers 501, a ready handler — anything but "no route".
    expect({ name, registered: response.status !== 404 || response.headers.get("content-type")?.includes("json") }).toEqual({ name, registered: true });
  }
  expect((await app.request(API_ROUTES.settings, { method: "PUT" })).status).not.toBe(405);
});

test("an unregistered path answers 404", async () => {
  expect((await app.request("/api/nope")).status).toBe(404);
});
