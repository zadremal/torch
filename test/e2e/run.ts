// End-to-end run of torch in a real browser (plan §11). Launch: `bun run e2e`.
// Builds the UI, writes synthetic transcripts to a temporary directory, starts
// `torch start` on them on a free port and walks through all screens in the installed Google Chrome (headless).
// The server, the browser and the temporary directory are cleaned up both on success and on failure.
// Not part of `bun test`: there are no *.test.ts files here.

import { join } from "node:path";
import { type Browser, findChrome, launchBrowser } from "./browser.ts";
import { runScenario, StepError } from "./scenario.ts";
import { REPO, startTorch, type Torch } from "./torch.ts";
import { createWorld, type World } from "./world.ts";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Builds the UI: the run server serves `web/dist`. false means the build failed. */
function buildWeb(): boolean {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode === 0) return true;
  console.error(`End-to-end run: the UI build (bun run build) failed.\n${build.stdout.toString()}${build.stderr.toString()}`);
  return false;
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const chrome = findChrome();
  if (chrome === null) {
    console.error("End-to-end run: Google Chrome not found. The run drives the installed Chrome and does not download a separate browser — install Google Chrome and run again.");
    return 1;
  }
  if (!buildWeb()) return 1;

  let world: World | undefined;
  let torch: Torch | undefined;
  let browser: Browser | undefined;
  const cleanUp = async (): Promise<void> => {
    await browser?.close().catch(() => {});
    await torch?.stop().catch(() => {});
    world?.remove();
  };
  // An interrupted run also leaves no server, browser or temporary directory behind.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void cleanUp().finally(() => process.exit(130)));
  }

  try {
    world = createWorld();
    torch = await startTorch(world);
    browser = await launchBrowser(chrome, join(world.root, "chrome-profile"));
    const defects = await runScenario({ world, baseUrl: torch.url, browser, page: await browser.page() });
    console.log(`End-to-end run passed in ${((Date.now() - startedAt) / 1000).toFixed(1)} s${defects > 0 ? `; known defects reproduced: ${defects}` : ""}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof StepError ? `✗ ${error.message}` : `End-to-end run did not complete: ${message(error)}`);
    if (torch) console.error(`\ntorch start output:\n${torch.output()}`);
    return 1;
  } finally {
    await cleanUp();
  }
}

process.exit(await main());
