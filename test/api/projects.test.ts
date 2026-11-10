// GET /api/projects: values for the project filter.
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createApi } from "../../src/api/routes.ts";
import type { ApiError, ProjectsResponse, SessionsResponse } from "../../src/contracts/api.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import projectsFixture from "../fixtures/dto/projects.json";
import { testConfig } from "../support/api.ts";
import { seedListSessions, seedReference } from "../support/reference-seed.ts";
import { seed } from "../support/seed.ts";

function api(db: Database) {
  const app = createApi({ db, config: testConfig(), now: () => 0 });
  return {
    app,
    async projects(query = ""): Promise<ProjectsResponse["projects"]> {
      const response = await app.request(`/api/projects${query}`);
      expect(response.status).toBe(200);
      return ((await response.json()) as ProjectsResponse).projects;
    },
  };
}

function seeded(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "a", project: "web" });
  seed.session(db, { id: "b", project: "billing" });
  seed.session(db, { id: "c", project: "web" });
  seed.session(db, { id: "d", project: "Zeta" });
  seed.session(db, { id: "e", project: null, cwd: null });
  seed.session(db, { id: "t1", project: "T", cwd: "/private/var/folders/zz/T/one", is_temp_dir: 1 });
  seed.session(db, { id: "t2", project: "web", cwd: "/private/tmp/web", is_temp_dir: 1 });
  return db;
}

test("projects by name, case-insensitive, with a session count; temporary directories and sessions without a project are not counted", async () => {
  expect(await api(seeded()).projects()).toEqual([
    { name: "billing", sessions: 1 },
    { name: "web", sessions: 2 },
    { name: "Zeta", sessions: 1 },
  ]);
});

test("temp=true adds sessions from temporary directories, temp=false equals the default", async () => {
  const client = api(seeded());
  expect(await client.projects("?temp=true")).toEqual([
    { name: "billing", sessions: 1 },
    { name: "T", sessions: 1 },
    { name: "web", sessions: 3 },
    { name: "Zeta", sessions: 1 },
  ]);
  expect(await client.projects("?temp=false")).toEqual(await client.projects());
  expect(await client.projects("?temp=")).toEqual(await client.projects());
});

test("a project's session count equals the list total with a filter by that project", async () => {
  const client = api(seeded());
  for (const temp of ["", "true"]) {
    for (const project of await client.projects(`?temp=${temp}`)) {
      const list = (await (await client.app.request(`/api/sessions?project=${project.name}&temp=${temp}`)).json()) as SessionsResponse;
      expect({ project: project.name, temp, total: list.total }).toEqual({ project: project.name, temp, total: project.sessions });
    }
  }
});

test("empty database — empty list", async () => {
  expect(await api(openMemoryDb()).projects()).toEqual([]);
});

test("the response on the reference database matches the dto/projects.json example", async () => {
  const db = openMemoryDb();
  seedReference(db);
  seedListSessions(db);
  expect(await api(db).projects()).toEqual(projectsFixture.projects);
});

test("invalid temp — 400 with ApiError", async () => {
  const response = await api(seeded()).app.request("/api/projects?temp=maybe");
  expect(response.status).toBe(400);
  expect(((await response.json()) as ApiError).error).toContain("temp");
});
