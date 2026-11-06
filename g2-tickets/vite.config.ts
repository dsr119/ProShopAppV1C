import { defineConfig } from "vite";

// Relative asset paths: the Even app loads the packed build from disk.
export default defineConfig({ base: "./", server: { port: 5173 } });
