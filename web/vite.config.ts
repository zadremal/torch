import react from "@vitejs/plugin-react";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { DEFAULT_PORT } from "../src/contracts/constants.ts";

const fromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@contracts": fromRoot("src/contracts"),
      "@fixtures": fromRoot("test/fixtures/dto"),
    },
  },
  css: {
    modules: {
      // `StatTile.module.css` + `.value` → `StatTile__value`: readable in the markup and the same in dev,
      // tests and the build. Module file names are unique (test/web/styles.test.ts), so the names are too.
      generateScopedName: (local, file) => `${basename(file).replace(/\.module\.css$/, "")}__${local}`,
    },
    preprocessorOptions: {
      // Sass warnings from the Carbon sources are not ours: keep only our own.
      scss: { quietDeps: true },
    },
  },
  server: {
    fs: { allow: [fromRoot(".")] },
    proxy: {
      "/api": `http://127.0.0.1:${DEFAULT_PORT}`,
    },
  },
});
