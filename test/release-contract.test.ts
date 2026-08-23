import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const manifest = (path: string): { name: string; version: string } =>
  JSON.parse(read(path)) as { name: string; version: string };

describe("coordinated prerelease contract", () => {
  it("keeps every release artifact on one semantic version", () => {
    const releases = [
      manifest("package.json"),
      manifest("packages/core/package.json"),
      manifest("packages/protocol/package.json"),
      manifest("packages/client/package.json"),
    ];
    const versions = new Set(releases.map(({ version }) => version));
    expect(versions.size).toBe(1);
    expect(releases[0]!.version).toMatch(/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    expect(read("server/go.mod")).toMatch(/^module github\.com\/dafepro\/canvas\/server$/mu);
  });

  it("keeps the exact-match client and server protocol versions aligned", () => {
    const client = read("packages/protocol/src/version.ts").match(
      /PROTOCOL_VERSION\s*=\s*(\d+)/u,
    )?.[1];
    const server = read("server/pkg/roomsdk/config.go").match(
      /defaultProtocolVersion\s*=\s*(\d+)/u,
    )?.[1];
    expect(client).toMatch(/^\d+$/u);
    expect(server).toBe(client);
    expect(read("packages/protocol/src/version.ts")).toContain(
      "clientVersion === PROTOCOL_VERSION",
    );
  });
});
