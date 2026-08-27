import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@canvas-physics/core/testing",
        replacement: resolve(import.meta.dirname, "packages/core/src/testing/index.ts"),
      },
      {
        find: "@canvas-physics/core",
        replacement: resolve(import.meta.dirname, "packages/core/src/index.ts"),
      },
      {
        find: "@canvas-physics/protocol",
        replacement: resolve(import.meta.dirname, "packages/protocol/src/index.ts"),
      },
      {
        find: "@canvas-physics/client/runtime",
        replacement: resolve(import.meta.dirname, "packages/client/src/runtime/index.ts"),
      },
      {
        find: "@canvas-physics/client/testing",
        replacement: resolve(import.meta.dirname, "packages/client/src/testing/index.ts"),
      },
      {
        find: "@canvas-physics/client/worker-runtime",
        replacement: resolve(import.meta.dirname, "packages/client/src/simulation/worker-runtime.ts"),
      },
      {
        find: "@canvas-physics/client/worker",
        replacement: resolve(import.meta.dirname, "packages/client/src/simulation/simulation.worker.ts"),
      },
      {
        find: "@canvas-physics/client",
        replacement: resolve(import.meta.dirname, "packages/client/src/index.ts"),
      },
    ],
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    environment: "node",
  },
});
