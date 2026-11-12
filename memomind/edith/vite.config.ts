import { defineConfig } from "vite";

// Relative paths: the MemoMind app runs the packed build from its own storage.
// public/manifest.json is copied into dist as-is.
export default defineConfig({
  base: "./",
  server: { port: 5174, fs: { allow: ["../.."] } },
  build: { target: "es2020", outDir: "dist", emptyOutDir: true, sourcemap: false },
});
