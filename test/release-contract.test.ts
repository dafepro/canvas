import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const manifest = (path: string): { name: string; version: string } =>
  JSON.parse(read(path)) as { name: string; version: string };

describe("coordinated release contract", () => {
  it("keeps every release artifact on one semantic version", () => {
    const releases = [
      manifest("package.json"),
      manifest("packages/core/package.json"),
      manifest("packages/protocol/package.json"),
      manifest("packages/client/package.json"),
    ];
    const versions = new Set(releases.map(({ version }) => version));
    expect(versions.size).toBe(1);
    expect(releases[0]!.version).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u);
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

  it("publishes an explicit compatibility and breaking-change policy", () => {
    const release = read("docs/RELEASE_CONTRACT.md");
    const majorNotes = "docs/MAJOR_VERSION_NOTES.md";

    expect(release).not.toContain("Backward compatibility is explicitly rejected");
    expect(release).toContain("external application clients");
    expect(release).toContain("never be replaced or republished");
    expect(release).toContain("MAJOR_VERSION_NOTES.md");
    expect(existsSync(join(root, majorNotes))).toBe(true);
    expect(read(majorNotes)).toContain("Next major");
    expect(read(majorNotes)).toContain("Migration");
    expect(read("docs/COMPATIBILITY_AUDIT.md")).toContain("Findings ledger");
    expect(read("docs/COMPATIBILITY_AUDIT.md")).toContain("Residual risks");
  });
});
