// Component styles are CSS modules (plan §9.4). Plain CSS has no compile step that rejects a misspelled
// token or class: these checks take the place of the Sass compiler.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_DIR = join(import.meta.dir, "../../web");
const SRC = join(WEB_DIR, "src");
const scan = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: SRC, absolute: true })].sort();
const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => relative(SRC, file);

const modules = scan("**/*.module.css");
const styleSheets = scan("**/*.css");
const scripts = scan("**/*.{ts,tsx}");

const webRequire = createRequire(join(WEB_DIR, "package.json"));

/**
 * Carbon tokens on `:root`: what `theme.theme()` emits in the Sass entry. Compiled on its own, without the rest
 * of Carbon, which takes seconds. Bare imports resolve from the importing file, as Vite resolves them.
 */
async function rootTokens(): Promise<Set<string>> {
  // Sass is installed in the web package, not in the root: only the call used here is described.
  const sass: {
    compileString(source: string, options: object): { css: string };
  } = await import(webRequire.resolve("sass"));
  const nodeImporter = {
    findFileUrl(url: string, context: { containingUrl: URL | null }) {
      if (/^[./]|:/.test(url)) return null;
      const parts = url.split("/");
      const pkg = url.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      const from = context.containingUrl ? fileURLToPath(context.containingUrl) : join(WEB_DIR, "package.json");
      return pathToFileURL(join(dirname(createRequire(from).resolve(`${pkg}/package.json`)), url.slice(pkg.length)));
    },
  };
  const { css } = sass.compileString(`@use '@carbon/react/scss/theme';\n${ROOT_RULE}`, {
    url: pathToFileURL(join(SRC, "styles/index.scss")),
    importers: [nodeImporter],
    quietDeps: true,
  });
  return new Set([...css.matchAll(/(--cds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}
const ROOT_RULE = ":root {\n  @include theme.theme();\n}";

const used = (pattern: RegExp, files: string[]) =>
  files.flatMap((file) => [...read(file).matchAll(pattern)].map((m) => ({ file: rel(file), name: m[1]! })));

describe("CSS modules", () => {
  test("Sass is only the Carbon entry point; every component style is a module", () => {
    expect(scan("**/*.scss").map(rel)).toEqual(["styles/index.scss"]);
    expect(styleSheets.filter((file) => !file.endsWith(".module.css")).map(rel)).toEqual(["styles/variables.css"]);
  });

  test("module file names are unique: the generated class name is <file name>__<class>", () => {
    const names = modules.map((file) => basename(file));
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  test("every Carbon token used without a fallback is defined on :root by the Sass entry", async () => {
    expect(read(join(SRC, "styles/index.scss"))).toContain(ROOT_RULE);
    const tokens = await rootTokens();
    expect(tokens.size).toBeGreaterThan(500);
    // A component token outside the theme is used with an explicit fallback: `var(--cds-x, …)`.
    const unknown = used(/var\((--cds-[a-z0-9-]+)\)/g, [...styleSheets, ...scripts]).filter((u) => !tokens.has(u.name));
    expect(unknown).toEqual([]);
  });

  test("every torch custom property used is defined in the styles or set by a component", () => {
    const defined = new Set([
      ...used(/(--torch-[a-z0-9-]+)\s*:/g, styleSheets).map((u) => u.name),
      // Set from code as inline styles: `style={{ "--torch-timeline-label": … }}`.
      ...used(/["'](--torch-[a-z0-9-]+)["']\s*:/g, scripts).map((u) => u.name),
    ]);
    const undefinedNames = used(/var\((--torch-[a-z0-9-]+)/g, styleSheets).filter((u) => !defined.has(u.name));
    expect(undefinedNames).toEqual([]);
  });

  test("palette colors in variables.css are the @carbon/colors values", async () => {
    const colors: Record<string, string> = await import(webRequire.resolve("@carbon/colors"));
    const declared = [...read(join(SRC, "styles/variables.css")).matchAll(/--torch-color-([a-z]+)-(\d+):\s*(#[0-9a-f]+);/g)];
    expect(declared.length).toBeGreaterThan(0);
    for (const [, hue, grade, value] of declared) expect({ color: `${hue}${grade}`, value }).toEqual({ color: `${hue}${grade}`, value: colors[`${hue}${grade}`]! });
  });

  test("every class a component reads from a module is defined in that module", () => {
    const missing: string[] = [];
    for (const file of scripts) {
      const source = read(file);
      for (const [, alias, path] of source.matchAll(/^import (\w+) from "([^"]+\.module\.css)";$/gm)) {
        const css = read(join(dirname(file), path!));
        const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
        for (const [, local] of source.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, "g"))) {
          if (!classes.has(local!)) missing.push(`${rel(file)}: ${alias}.${local}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
