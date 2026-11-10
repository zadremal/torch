import react from "@vitejs/plugin-react";
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
