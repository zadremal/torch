// `hooks/record.sh`: the event from stdin lands in the spool as a separate file, atomically (plan §7.2).
// The script runs as a copy from a temporary data directory, the way `torch setup` installs it.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import type { HookPayload } from "../../src/contracts/enrich.ts";

const REPO = join(import.meta.dir, "..", "..");
const RECORD = join(REPO, "hooks", "record.sh");

const EVENT: HookPayload = {
  hook_event_name: "InstructionsLoaded",
  session_id: "0b7c7a52-2f7e-4c56-9a55-3d1f0e6b8a11",
  transcript_path: "/tmp/projects/-repo/0b7c7a52.jsonl",
  cwd: "/repo",
  file_path: "/repo/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "torch-record-"));
  const dataDir = join(root, "torch");
  const { spoolDir } = loadConfig({ dataDir });
  // The script sits where setup installs it: <data directory>/hooks.
  const script = join(dataDir, "hooks", "record.sh");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(RECORD, script);
  // The hook environment: there are no torch variables in it, and the home directory is foreign.
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: join(root, "home") };
  return {
    root,
    spoolDir,
    script,
    env,
    record: (stdin: string, overrides: Record<string, string | undefined> = {}) => Bun.spawnSync(["/bin/sh", script], { stdin: Buffer.from(stdin), env: { ...env, ...overrides } }),
    files: () => (existsSync(spoolDir) && statSync(spoolDir).isDirectory() ? readdirSync(spoolDir).sort() : []),
  };
}

const output = (run: { exitCode: number; stdout: Buffer; stderr: Buffer }) => ({ code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() });
const SILENT = { code: 0, stdout: "", stderr: "" };

/** A directory with commands under the listed names: a PATH with nothing else in it. */
function binWith(root: string, commands: string[]): string {
  const bin = join(root, `bin-${commands.join("-") || "empty"}`);
  mkdirSync(bin);
  for (const command of commands) symlinkSync(Bun.which(command)!, join(bin, command));
  return bin;
}

/** Waits until the condition holds: the handler writes the file in another process. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(10);
  if (!condition()) throw new Error("the condition did not hold within 2 seconds");
}

describe("hooks/record.sh", () => {
  test("scripts pass the sh -n check", () => {
    for (const script of [RECORD, join(REPO, "setup.sh")]) {
      const check = Bun.spawnSync(["sh", "-n", script]);

      expect({ script, code: check.exitCode, stderr: check.stderr.toString() }).toEqual({ script, code: 0, stderr: "" });
    }
  });

  test("puts the event as a single .json file into the data directory spool, with no output and exit code 0", () => {
    const s = sandbox();
    const body = JSON.stringify(EVENT);

    expect(output(s.record(body))).toEqual(SILENT);

    const files = s.files();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-\d+\.json$/);
    expect(readFileSync(join(s.spoolDir, files[0]!), "utf8")).toBe(body);
    expect(statSync(join(s.spoolDir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  test("the spool is determined by the script location, not by the environment", () => {
    const s = sandbox();
    const elsewhere = join(s.root, "elsewhere");

    // TORCH_HOME and HOME point elsewhere; the working directory is foreign too.
    const run = Bun.spawnSync(["/bin/sh", s.script], { stdin: Buffer.from(JSON.stringify(EVENT)), env: { ...s.env, TORCH_HOME: elsewhere }, cwd: tmpdir() });

    expect(output(run)).toEqual(SILENT);
    expect(s.files()).toHaveLength(1);
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(join(s.root, "home"))).toBe(false);
  });

  test("the body is preserved byte for byte: line breaks, quotes, non-Latin characters", () => {
    const s = sandbox();
    const body = `${JSON.stringify({ ...EVENT, hook_event_name: "PostCompact", compact_summary: "日本語 1\nline \"2\" $HOME `id` \\ 🌍" }, null, 2)}\n\n`;

    s.record(body);

    expect(readFileSync(join(s.spoolDir, s.files()[0]!), "utf8")).toBe(body);
  });

  test("the write is atomic: until stdin is closed, there is no event file in the spool", async () => {
    const s = sandbox();
    const body = JSON.stringify({ ...EVENT, compact_summary: "x".repeat(100_000) });
    const half = body.slice(0, 50_000);
    const proc = Bun.spawn(["/bin/sh", s.script], { stdin: "pipe", env: s.env, stdout: "pipe", stderr: "pipe" });

    proc.stdin.write(half);
    await proc.stdin.flush();
    // The first half is already on disk, under a temporary dot-prefixed name.
    await until(() => s.files().some((name) => statSync(join(s.spoolDir, name)).size === half.length));
    expect(s.files()).toHaveLength(1);
    expect(s.files()[0]).toMatch(/^\..+\.tmp$/);

    proc.stdin.write(body.slice(50_000));
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);

    const files = s.files();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-\d+\.json$/);
    expect(readFileSync(join(s.spoolDir, files[0]!), "utf8")).toBe(body);
  });

  test("events that arrive simultaneously land in different files", async () => {
    const s = sandbox();
    const bodies = Array.from({ length: 8 }, (_, n) => JSON.stringify({ ...EVENT, file_path: `/repo/rules/${n}.md` }));

    await Promise.all(bodies.map((body) => Bun.spawn(["/bin/sh", s.script], { stdin: Buffer.from(body), env: s.env }).exited));

    expect(s.files().map((name) => readFileSync(join(s.spoolDir, name), "utf8")).sort()).toEqual([...bodies].sort());
  });

  test("an empty stdin leaves no file", () => {
    const s = sandbox();

    expect(output(s.record(""))).toEqual(SILENT);

    expect(s.files()).toEqual([]);
  });

  test("an inaccessible spool does not disturb the session: no output, exit code 0", () => {
    const s = sandbox();
    // A file lies in place of the spool: the directory cannot be created.
    writeFileSync(s.spoolDir, "");

    expect(output(s.record(JSON.stringify(EVENT)))).toEqual(SILENT);
  });

  test("without the date command the event still lands in the spool, no output", () => {
    const s = sandbox();
    const body = JSON.stringify(EVENT);

    expect(output(s.record(body, { PATH: binWith(s.root, ["mkdir", "cat", "mv", "rm"]) }))).toEqual(SILENT);

    const files = s.files();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[^.].*\.json$/);
    expect(readFileSync(join(s.spoolDir, files[0]!), "utf8")).toBe(body);
  });

  test("without any external command there is no output, exit code 0, and no finished event file", () => {
    const s = sandbox();

    expect(output(s.record(JSON.stringify(EVENT), { PATH: binWith(s.root, []) }))).toEqual(SILENT);
    expect(output(s.record(JSON.stringify(EVENT), { PATH: binWith(s.root, ["mkdir"]) }))).toEqual(SILENT);

    expect(s.files().filter((name) => name.endsWith(".json"))).toEqual([]);
  });
});
