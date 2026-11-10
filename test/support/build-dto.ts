// Writes the reference session's API responses to test/fixtures/dto. Launch: `bun run fixtures`.
// The test test/support/fixtures.test.ts checks that the files in the repository match the generator.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDtoFixtures, fixtureFiles } from "./reference-dto.ts";

export const DTO_DIR = join(import.meta.dir, "..", "fixtures", "dto");

export const serialize = (value: unknown) => `${JSON.stringify(value, null, 1)}\n`;

if (import.meta.main) {
  mkdirSync(DTO_DIR, { recursive: true });
  const files = fixtureFiles(await buildDtoFixtures());
  for (const [name, value] of Object.entries(files)) writeFileSync(join(DTO_DIR, name), serialize(value));
  console.log(`Files written: ${Object.keys(files).length} → ${DTO_DIR}`);
}
