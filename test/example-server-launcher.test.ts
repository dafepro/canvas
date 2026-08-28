import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const examples = {
  "soccer-lounge": 8082,
  "item-playground": 8083,
  "linked-rooms": 8084,
  "basketball-arena": 8085,
} as const;

interface PrintedConfig {
  address: string;
  canvasesDir: string;
  dataDir: string;
  definitionsDir: string;
  example: string;
  releaseVersion: string;
}

const printConfig = (example: string, environment: NodeJS.ProcessEnv = {}): PrintedConfig =>
  JSON.parse(execFileSync(
    process.execPath,
    [resolve(root, "scripts/run-example-server.mjs"), example, "--print-config"],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...environment } },
  )) as PrintedConfig;

describe("example server launcher", () => {
  it("isolates durable demo data by coordinated library release", () => {
    for (const [example, port] of Object.entries(examples)) {
      const config = printConfig(example);
      expect(config).toMatchObject({
        example,
        address: `:${port}`,
        releaseVersion: "0.4.1",
      });
      expect(config.canvasesDir.replaceAll("\\", "/").endsWith(
        `/examples/${example}/server/canvases`,
      )).toBe(true);
      expect(config.definitionsDir.replaceAll("\\", "/").endsWith(
        `/examples/${example}/server/definitions`,
      )).toBe(true);
      expect(config.dataDir.replaceAll("\\", "/").endsWith(
        `/examples/${example}/.data/v0.4.1`,
      )).toBe(true);
    }
  });

  it("keeps an explicit data directory available for persistence testing", () => {
    const custom = resolve(root, "custom-example-data");
    expect(printConfig("item-playground", { CANVAS_EXAMPLE_DATA_DIR: custom }).dataDir)
      .toBe(custom);
  });

  it("routes every package server command through the checked launcher", () => {
    for (const example of Object.keys(examples)) {
      const manifest = JSON.parse(readFileSync(
        resolve(root, "examples", example, "package.json"),
        "utf8",
      )) as { scripts: { server: string } };
      expect(manifest.scripts.server).toBe(
        `node ../../scripts/run-example-server.mjs ${example}`,
      );
    }
  });
});
