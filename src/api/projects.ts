// Values for the project filter. Package A1.
import type { ProjectsResponse } from "../contracts/api.ts";
import { type Handler } from "./context.ts";
import { badQuery, flagParam, sessionFilterSql } from "./filters.ts";

export const listProjects: Handler = (c) => {
  let temp: boolean | undefined;
  try {
    temp = flagParam("temp", c.req.query("temp"));
  } catch (error) {
    return badQuery(c, error);
  }
  const { where, params } = sessionFilterSql({ temp });
  const projects = c
    .get("db")
    .query<{ name: string; sessions: number }, (string | number)[]>(
      `SELECT project AS name, COUNT(*) AS sessions
       FROM sessions
       WHERE ${where} AND project IS NOT NULL
       GROUP BY project
       ORDER BY project COLLATE NOCASE, project`,
    )
    .all(...params);
  return c.json<ProjectsResponse>({ projects });
};
