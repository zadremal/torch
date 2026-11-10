// Walking the transcripts directory and files next to a transcript (plan §3.1, §6.1 step 1).
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAIN_AGENT_ID } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { discoverFiles, knownFiles, readAgentMeta, readCustomTitle } from "../../src/ingest/discover.ts";
import { seed } from "../support/seed.ts";
import { projectDirName, transcript, writeSession } from "../support/transcript.ts";

const tempRoot = () => mkdtempSync(join(tmpdir(), "torch-discover-"));

/** A walk in which there must be no unreadable directories. */
const discover = (root: string) =>
  discoverFiles(root, (dir, error) => {
    throw new Error(`unreadable directory ${dir}: ${String(error)}`);
  });

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("finds main files and subagent files, takes identifiers from the file names", () => {
  const root = tempRoot();
  const main = transcript({ sessionId: "s1", cwd: "/Users/dev/code/web" });
  const sub = transcript({ sessionId: "s1", agentId: "a7f3", cwd: "/Users/dev/code/web" });
  const written = writeSession(root, { main, subagents: [{ transcript: sub, meta: { agentType: "Explore" } }], customTitleFile: "Named" });
  const other = writeSession(root, { main: transcript({ sessionId: "s2", cwd: "/private/tmp/scratch" }) });

  expect(discover(root)).toEqual([
    { path: written.mainPath, kind: "main", sessionId: "s1", agentId: MAIN_AGENT_ID, sessionDir: written.sessionDir },
    { path: written.subagentPaths[0]!, kind: "subagent", sessionId: "s1", agentId: "a7f3", sessionDir: written.sessionDir },
    { path: other.mainPath, kind: "main", sessionId: "s2", agentId: MAIN_AGENT_ID, sessionDir: other.sessionDir },
  ]);
});

test("the session identifier is the file name, not the sessionId field of the lines", () => {
  const root = tempRoot();
  // A continued session copies the lines of the original together with its sessionId.
  const copied = transcript({ sessionId: "original" });
  copied.prompt("Continue");
  write(join(root, "-Users-dev-code-web", "resumed.jsonl"), copied.jsonl());

  expect(discover(root).map((file) => file.sessionId)).toEqual(["resumed"]);
});

test("skips everything that is not a transcript: meta.json, title, large outputs, foreign files", () => {
  const root = tempRoot();
  const project = join(root, projectDirName("/Users/dev/code/web"));
  write(join(project, "s1.jsonl"), "");
  write(join(project, "s1", "custom-title.json"), "{}");
  write(join(project, "s1", "tool-results", "toolu_1.txt"), "big output");
  write(join(project, "s1", "tool-results", "nested.jsonl"), "{}\n");
  write(join(project, "s1", "subagents", "agent-a1.meta.json"), "{}");
  write(join(project, "s1", "subagents", "notes.jsonl"), "{}\n");
  write(join(project, "notes.txt"), "");
  write(join(root, "stray.jsonl"), "{}\n");

  expect(discover(root).map((file) => file.path)).toEqual([join(project, "s1.jsonl")]);
});

test("subagents are found even without the session's main file", () => {
  const root = tempRoot();
  const path = join(root, "-Users-dev-code-web", "s1", "subagents", "agent-a1.jsonl");
  write(path, "");

  expect(discover(root)).toEqual([{ path, kind: "subagent", sessionId: "s1", agentId: "a1", sessionDir: join(root, "-Users-dev-code-web", "s1") }]);
});

test("no transcripts root — no files", () => {
  expect(discover(join(tempRoot(), "missing"))).toEqual([]);
});

test("order is by path and does not depend on creation order", () => {
  const root = tempRoot();
  for (const name of ["c", "a", "b"]) write(join(root, "-p", `${name}.jsonl`), "");
  write(join(root, "-a", "z.jsonl"), "");

  expect(discover(root).map((file) => file.sessionId)).toEqual(["z", "a", "b", "c"]);
});

test("a file that is listed in the directory but no longer opens stays in the list: reading will filter it out", () => {
  const root = tempRoot();
  const path = join(root, "-p", "gone.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join(root, "nowhere.jsonl"), path);

  expect(discover(root).map((file) => file.path)).toEqual([path]);
});

test("an unreadable directory does not abort the walk: it is reported, the rest is found", () => {
  const root = tempRoot();
  write(join(root, "-locked", "s1.jsonl"), "");
  write(join(root, "-open", "s2.jsonl"), "");
  write(join(root, "-open", "s2", "subagents", "agent-a1.jsonl"), "");
  write(join(root, "-open", "s3", "subagents", "agent-a2.jsonl"), "");
  const locked = [join(root, "-locked"), join(root, "-open", "s3", "subagents")];
  for (const dir of locked) chmodSync(dir, 0o000);

  const unreadable: string[] = [];
  try {
    const files = discoverFiles(root, (dir, error) => unreadable.push(`${dir}: ${(error as { code?: string }).code}`));

    expect(files.map((file) => file.path)).toEqual([join(root, "-open", "s2.jsonl"), join(root, "-open", "s2", "subagents", "agent-a1.jsonl")]);
    expect(unreadable).toEqual(locked.map((dir) => `${dir}: EACCES`));
  } finally {
    for (const dir of locked) chmodSync(dir, 0o700);
  }
});

test("an unreadable file next to a transcript is an error, not “no file”", () => {
  const root = tempRoot();
  // Directories stand in place of meta.json and custom-title.json.
  mkdirSync(join(root, "agent-a1.meta.json"));
  mkdirSync(join(root, "s1", "custom-title.json"), { recursive: true });

  expect(() => readAgentMeta(join(root, "agent-a1.jsonl"))).toThrow("EISDIR");
  expect(() => readCustomTitle(join(root, "s1"))).toThrow("EISDIR");
});

test("subagent meta.json: fields from plan §3.1, missing ones are null", () => {
  const root = tempRoot();
  const path = join(root, "agent-a1.jsonl");
  expect(readAgentMeta(path)).toBeNull();

  write(join(root, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find imports", toolUseId: "toolu_1", spawnDepth: 2, extra: true }));
  expect(readAgentMeta(path)).toEqual({ agentType: "Explore", description: "Find imports", toolUseId: "toolu_1", spawnDepth: 2, model: null, parentAgentId: null });

  write(join(root, "agent-a1.meta.json"), JSON.stringify({ agentType: 7, model: "claude-haiku-5-5", parentAgentId: "a0" }));
  expect(readAgentMeta(path)).toEqual({ agentType: null, description: null, toolUseId: null, spawnDepth: null, model: "claude-haiku-5-5", parentAgentId: "a0" });
});

test("an unfinished or wrong JSON next to a transcript is read as absent", () => {
  const root = tempRoot();
  write(join(root, "agent-a1.meta.json"), '{"agentType": "Expl');
  expect(readAgentMeta(join(root, "agent-a1.jsonl"))).toBeNull();

  write(join(root, "s1", "custom-title.json"), "[]");
  expect(readCustomTitle(join(root, "s1"))).toBeNull();
});

test("custom-title.json: the name from the customTitle field", () => {
  const root = tempRoot();
  expect(readCustomTitle(join(root, "s1"))).toBeNull();
  write(join(root, "s1", "custom-title.json"), JSON.stringify({ customTitle: "Billing migration" }));
  expect(readCustomTitle(join(root, "s1"))).toBe("Billing migration");
});

test("bookkeeping from earlier passes is read by file path", () => {
  const db = openMemoryDb();
  const here = seed.sourceFile(db, { path: "/t/p/here.jsonl", session_id: "here", parsed_offset: 120, last_event_ts: 900 });
  const gone = seed.sourceFile(db, { path: "/t/p/gone/subagents/agent-a1.jsonl", session_id: "gone", kind: "subagent", agent_id: "a1", missing_since: 500 });

  expect([...knownFiles(db)]).toEqual([
    [gone.path, gone],
    [here.path, here],
  ]);
});
