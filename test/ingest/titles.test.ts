// Session titles from the desktop app metadata (plan §3.2): files
// `<uuid>/<uuid>/local_<uuid>.json` in a temporary directory.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadDesktopTitles } from "../../src/ingest/titles.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "torch-titles-"));

function write(root: string, relativePath: string, content: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

/** A metadata file with fields from plan §3.2. */
const metadata = (cliSessionId: string, title: string) => ({
  cliSessionId,
  title,
  titleSource: "auto",
  model: "claude-opus-5-5",
  createdAt: 1790000000000,
  lastActivityAt: 1790000600000,
  isArchived: false,
});

test("titles are read by cliSessionId from local_<uuid>.json files", () => {
  const root = tempDir();
  write(root, "acc-1/org-1/local_aaa.json", metadata("session-1", "Migrate billing client"));
  write(root, "acc-1/org-1/local_bbb.json", metadata("session-2", "  Fix flaky test  "));
  write(root, "acc-2/org-9/local_ccc.json", metadata("session-3", "Billing migration"));

  expect(loadDesktopTitles(root)).toEqual(
    new Map([
      ["session-1", "Migrate billing client"],
      ["session-2", "Fix flaky test"],
      ["session-3", "Billing migration"],
    ]),
  );
});

test("no metadata directory — no titles", () => {
  expect(loadDesktopTitles(join(tempDir(), "missing"))).toEqual(new Map());
  expect(loadDesktopTitles(tempDir())).toEqual(new Map());
});

test("a broken file, a file without a title or without cliSessionId and foreign files are skipped", () => {
  const root = tempDir();
  write(root, "acc-1/org-1/local_ok.json", metadata("session-1", "Kept"));
  write(root, "acc-1/org-1/local_broken.json", '{"cliSessionId": "session-2", "title": "Trunc');
  write(root, "acc-1/org-1/local_untitled.json", { cliSessionId: "session-3", titleSource: "auto" });
  write(root, "acc-1/org-1/local_blank.json", metadata("session-4", "   "));
  write(root, "acc-1/org-1/local_orphan.json", { title: "No session" });
  write(root, "acc-1/org-1/local_array.json", [metadata("session-5", "In array")]);
  write(root, "acc-1/org-1/local_types.json", { cliSessionId: 42, title: { text: "Wrong types" } });
  write(root, "acc-1/org-1/settings.json", metadata("session-6", "Other file"));
  write(root, "acc-1/org-1/local_notes.txt", JSON.stringify(metadata("session-7", "Not json")));

  expect(loadDesktopTitles(root)).toEqual(new Map([["session-1", "Kept"]]));
});

test("two files for one session: the result does not depend on walk order — the last by path is taken", () => {
  const root = tempDir();
  write(root, "acc-1/org-1/local_bbb.json", metadata("session-1", "From bbb"));
  write(root, "acc-1/org-1/local_aaa.json", metadata("session-1", "From aaa"));
  expect(loadDesktopTitles(root).get("session-1")).toBe("From bbb");
});
