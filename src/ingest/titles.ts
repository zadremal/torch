// Session titles from the desktop app metadata (plan §3.2). Package I2.
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";

/** `cliSessionId` → `title` from the `local_<uuid>.json` files in the metadata directory. */
export function loadDesktopTitles(desktopSessionsDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  // The directory is absent if the desktop app is not installed.
  if (!existsSync(desktopSessionsDir)) return titles;

  // The walk order is fixed by sorting: if two files turn up for one session, the result does not
  // depend on the order the file system returns entries in.
  const paths = [...new Glob("**/local_*.json").scanSync({ cwd: desktopSessionsDir, absolute: true })].sort();
  for (const path of paths) {
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // The file is being written by the app or vanished between the walk and the read: the title will arrive later.
      continue;
    }
    if (typeof meta !== "object" || meta === null) continue;
    const { cliSessionId, title } = meta as { cliSessionId?: unknown; title?: unknown };
    if (typeof cliSessionId !== "string" || typeof title !== "string" || title.trim() === "") continue;
    titles.set(cliSessionId, title.trim());
  }
  return titles;
}
