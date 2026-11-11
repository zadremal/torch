// The provider registry and the `provider` key of config.json.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { DEFAULT_PROVIDER, PROVIDER_IDS } from "../../src/contracts/provider.ts";
import { providerFor } from "../../src/providers/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data directory with the given config.json; null — no file. */
function dataDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "torch-provider-"));
  dirs.push(dir);
  if (config !== null) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

test("every id has a provider that reports that id", () => {
  for (const id of PROVIDER_IDS) expect(providerFor(id).id).toBe(id);
});

test("without config.json, or without the key, the provider is anthropic", () => {
  expect(DEFAULT_PROVIDER).toBe("anthropic");
  expect(loadConfig({ dataDir: dataDir(null) }).provider).toBe("anthropic");
  expect(loadConfig({ dataDir: dataDir({ port: 0 }) }).provider).toBe("anthropic");
});

test("the provider key of config.json is read", () => {
  expect(loadConfig({ dataDir: dataDir({ provider: "bedrock" }) }).provider).toBe("bedrock");
});

test("an unknown provider is an error naming the file and the allowed values", () => {
  for (const provider of ["vertex", "Bedrock", 1, null]) {
    const dir = dataDir({ provider });
    expect(() => loadConfig({ dataDir: dir })).toThrow(`${join(dir, "config.json")}: provider must be one of anthropic, bedrock`);
  }
});
