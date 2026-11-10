// A real `torch start` process for the run: a free port, the data directory and the home directory are
// temporary, so neither the real history nor the real ~/.torch is visible to the process.

import { fileURLToPath } from "node:url";
import type { World } from "./world.ts";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));

const START_MS = 30_000;

export interface Torch {
  /** Server address with the actual port. */
  url: string;
  /** Everything the process printed: shown when the run fails. */
  output(): string;
  stop(): Promise<void>;
}

/** Launches `torch start --no-open` on a free port and waits for the line with the address. */
export async function startTorch(world: World): Promise<Torch> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "start", "--no-open", "--port", "0"], {
    cwd: REPO,
    env: { ...process.env, TORCH_HOME: world.dataDir, HOME: world.root },
    stdout: "pipe",
    stderr: "pipe",
  });
  let printed = "";
  let onOutput = (): void => {};
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      printed += decoder.decode(chunk, { stream: true });
      onOutput();
    }
  };
  const drained = Promise.all([collect(proc.stdout), collect(proc.stderr)]);
  const stop = async (): Promise<void> => {
    proc.kill("SIGTERM");
    await proc.exited;
    await drained;
  };

  const url = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), START_MS);
    const done = (value: string | null): void => {
      clearTimeout(timer);
      resolve(value);
    };
    onOutput = () => {
      const found = /^torch: (http:\/\/\S+)$/m.exec(printed)?.[1];
      if (found) done(found);
    };
    void proc.exited.then(() => drained).then(() => done(null));
  });
  if (url === null) {
    await stop();
    throw new Error(`torch start did not print the server address:\n${printed}`);
  }
  return { url, output: () => printed, stop };
}
