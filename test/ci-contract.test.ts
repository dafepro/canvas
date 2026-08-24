import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("cross-platform release verification", () => {
  it("runs the library gate on Windows and Linux", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm vitest run");
    expect(workflow).toContain('pnpm -r --filter "./packages/*" build');
    expect(workflow).toContain("go -C server test ./...");
    expect(workflow).toContain("if: runner.os == 'Linux'");
    expect(workflow).toContain("go -C server test ./... -race");
  });

  it("fails when checked-in protocol bindings are stale", () => {
    const workflow = read(".github/workflows/ci.yml");
    const verification = read("scripts/verify-generated.sh");
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
    expect(attributes).toContain("*.sh text eol=lf");
  });

  it("keeps packed external consumers in the release gate", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("test/package-artifacts.test.ts");
    expect(workflow).toContain("test/release-contract.test.ts");
    expect(workflow).toContain("test/library-boundaries.test.ts");
  });
});
