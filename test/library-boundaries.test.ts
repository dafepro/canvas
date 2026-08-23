import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const layers = ["core", "protocol", "client"] as const;
const allowedRuntimeDependencies: Record<(typeof layers)[number], ReadonlySet<string>> = {
  core: new Set(),
  protocol: new Set(["@bufbuild/protobuf", "@canvas-physics/core"]),
  client: new Set([
    "@canvas-physics/core",
    "@canvas-physics/protocol",
    "@dimforge/rapier2d-compat",
    "pixi.js",
  ]),
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });

const packageName = (specifier: string): string =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

describe("reusable package boundaries", () => {
  it("allows only the declared product-neutral dependency direction", () => {
    for (const [layerIndex, layer] of layers.entries()) {
      const packageRoot = join(root, "packages", layer);
      const sourceRoot = join(packageRoot, "src");
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      expect(new Set(Object.keys(manifest.dependencies ?? {}))).toEqual(
        allowedRuntimeDependencies[layer],
      );

      for (const file of sourceFiles(sourceRoot)) {
        const source = readFileSync(file, "utf8");
        const imports = source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu);
        for (const match of imports) {
          const specifier = match[1]!;
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(file), specifier);
            expect(
              target === sourceRoot || target.startsWith(`${sourceRoot}${sep}`),
              `${relative(root, file)} imports outside its package source: ${specifier}`,
            ).toBe(true);
            continue;
          }
          const dependency = packageName(specifier);
          expect(
            allowedRuntimeDependencies[layer].has(dependency),
            `${relative(root, file)} imports forbidden dependency ${dependency}`,
          ).toBe(true);
          if (dependency.startsWith("@canvas-physics/")) {
            const dependencyLayer = dependency.slice("@canvas-physics/".length);
            expect(layers.indexOf(dependencyLayer as (typeof layers)[number])).toBeLessThan(
              layerIndex,
            );
          }
        }
      }
    }
  });
});
