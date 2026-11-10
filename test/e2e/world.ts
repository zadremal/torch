// The world of the end-to-end run: a temporary directory with synthetic transcripts and the torch data directory.
// Two sessions: the reference one following the mockup scenario (completed, five agents) and a short running one the
// run appends lines to. Times are counted from the launch so that the dashboard ranges and the
// Running status do not depend on the date of the run.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceFiles } from "../support/reference-transcript.ts";
import { REF_PRICES, REF_START, referenceScenario, type RefScenario } from "../support/reference.ts";
import { text, toolUse, transcript, writeSession, type Transcript } from "../support/transcript.ts";

const DAY_MS = 24 * 3_600_000;

/** The reference session started this many days ago: outside the "Last week" window and inside "Last month". */
const REFERENCE_AGE_DAYS = 10;

/** The running session started this long ago: inside the Running status window. */
const LIVE_AGE_MS = 2 * 60_000;

export const LIVE_SESSION = {
  id: "e2e00000-0000-4000-8000-000000000001",
  name: "Fix flaky checkout test",
  cwd: "/Users/dev/code/storefront",
} as const;

export interface World {
  /** Root of the temporary directory: the torch process's HOME points into it as well. */
  root: string;
  /** Value of TORCH_HOME. */
  dataDir: string;
  pricesPath: string;
  reference: RefScenario;
  /** Appends a tool result and a response with a new call to the running session: +1 tool call. */
  appendToLive(): void;
  remove(): void;
}

/** Shifts the times of transcript lines: the reference scenario is tied to the date of the mockup. */
function shift(t: Transcript, ms: number): Transcript {
  for (const line of t.lines) {
    if (typeof line.timestamp === "string") line.timestamp = new Date(Date.parse(line.timestamp) + ms).toISOString();
  }
  return t;
}

export function createWorld(now = Date.now()): World {
  const root = mkdtempSync(join(tmpdir(), "torch-e2e-"));
  const dataDir = join(root, "torch");
  const transcriptsDir = join(root, "projects");
  const pricesPath = join(dataDir, "prices.json");

  mkdirSync(dataDir, { recursive: true });
  // All paths torch searches in the home directory by default are redirected into the temporary one.
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ transcriptsDir, desktopSessionsDir: join(root, "desktop"), claudeSettingsPath: join(root, "claude-settings.json") }),
  );
  // The models of the reference scenario are in the reference price table: the cost is known for every call.
  writeFileSync(pricesPath, `${JSON.stringify(REF_PRICES, null, 2)}\n`);

  const files = referenceFiles();
  const delta = now - REFERENCE_AGE_DAYS * DAY_MS - REF_START;
  writeSession(transcriptsDir, { main: shift(files.main, delta), subagents: files.subagents!.map((sub) => ({ ...sub, transcript: shift(sub.transcript, delta) })) });

  const live = transcript({ sessionId: LIVE_SESSION.id, cwd: LIVE_SESSION.cwd, startAt: now - LIVE_AGE_MS });
  live.prompt("The checkout test fails one run in five. Find out why and fix it.");
  let pending = live.tick(4000).assistant({ blocks: [text("Reading the test"), toolUse("Read", { file_path: `${LIVE_SESSION.cwd}/tests/checkout.test.ts` })], usage: { input: 1200, output: 80 } }).toolUseIds[0]!;
  live.aiTitle(LIVE_SESSION.name);
  const { mainPath } = writeSession(transcriptsDir, { main: live });

  return {
    root,
    dataDir,
    pricesPath,
    reference: referenceScenario(),
    appendToLive() {
      const written = live.lines.length;
      live.at(Date.now()).toolResult(pending, { content: "test body" });
      pending = live.tick(500).assistant({ blocks: [text("Running it"), toolUse("Bash", { command: "bun test tests/checkout.test.ts" })], usage: { input: 1400, output: 60 } }).toolUseIds[0]!;
      appendFileSync(mainPath, live.lines.slice(written).map((line) => `${JSON.stringify(line)}\n`).join(""));
    },
    remove() {
      // Chrome processes may still append to the profile when the main one has already exited.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
