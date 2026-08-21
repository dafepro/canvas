import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // The Rapier build is WebAssembly, so let Vite pre-bundle it once.
    include: ["@dimforge/rapier2d-compat"],
  },
  build: {
    target: "es2022",
  },
});
