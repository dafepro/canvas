import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("cross-platform release verification", () => {
  it("runs the library gate on Windows and Linux", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("pnpm/setup@v2");
    expect(workflow).toContain("actions/setup-go@v7");
    expect(workflow).not.toContain("actions/setup-node@");
    expect(workflow).not.toContain("pnpm/action-setup@");
    expect(workflow).not.toContain("arduino/setup-protoc@");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm vitest run");
    expect(workflow).toContain('pnpm -r --filter "./packages/*" build');
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("go -C server test ./...");
    expect(workflow).toContain("if: runner.os == 'Linux'");
    expect(workflow).toContain("go -C server test ./... -race");
  });

  it("fails when checked-in protocol bindings are stale", () => {
    const workflow = read(".github/workflows/ci.yml");
    const verification = read("scripts/verify-generated.sh");
    const tsGeneration = read("packages/protocol/scripts/generate.sh");
    const goGeneration = read("server/scripts/generate.sh");
    const attributes = read(".gitattributes");

    expect(workflow).toContain("bash scripts/verify-generated.sh");
    expect(verification).toContain("pnpm --filter @canvas-physics/protocol generate");
    expect(verification).toContain("bash server/scripts/generate.sh");
    expect(verification).toContain("git diff --exit-code --");
    expect(verification).toContain("packages/protocol/src/gen/room.ts");
    expect(verification).toContain("server/gen/canvasphysicsv1/room.pb.go");
    expect(goGeneration).toContain("protoc-gen-go@v1.36.12");
    expect(goGeneration).toContain("protoc-gen-go --version");
    expect(goGeneration).not.toContain("protoc-gen-go@latest");
    expect(tsGeneration).toContain("Windows_NT");
    expect(tsGeneration).toContain('${PLUGIN}.CMD');
    expect(attributes).toContain("*.sh text eol=lf");
  });

  it("keeps packed external consumers in the release gate", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("test/package-artifacts.test.ts");
    expect(workflow).toContain("test/release-contract.test.ts");
    expect(workflow).toContain("test/library-boundaries.test.ts");
    expect(read("test/package-artifacts.test.ts")).toContain('"basketball-arena"');
  });

  it("keeps every reference integration on the real-process smoke gate", () => {
    for (const [example, test] of [
      ["soccer-lounge", "soccer-lounge.e2e.test.ts"],
      ["item-playground", "item-playground.e2e.test.ts"],
      ["linked-rooms", "linked-rooms.e2e.test.ts"],
      ["basketball-arena", "basketball-arena.e2e.test.ts"],
    ] as const) {
      expect(existsSync(resolve(root, "examples", example, "test", test))).toBe(true);
    }
    expect(existsSync(resolve(root, "test/example-catalog-compatibility.test.ts"))).toBe(true);
    expect(existsSync(resolve(root, "test/example-server-launcher.test.ts"))).toBe(true);
  });

  it("resolves workspace packages from source during repository tests", () => {
    const config = read("vitest.config.ts");

    for (const layer of ["core", "protocol", "client"]) {
      expect(config).toContain(`"@canvas-physics/${layer}"`);
      expect(config).toContain(`packages/${layer}/src/index.ts`);
    }
  });
});
