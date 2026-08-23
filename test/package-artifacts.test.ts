import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "..");
const packageDirectories = ["core", "protocol", "client"] as const;
const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const fixtureRoot of fixtureRoots) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
  fixtureRoots.clear();
});

const runPnpm = (arguments_: string[], cwd: string): void => {
  let pnpmCli = process.env.npm_execpath;
  if (!pnpmCli && process.platform === "win32") {
    const commands = execFileSync("where.exe", ["pnpm.cmd"], {
      encoding: "utf8",
    }).trim().split(/\r?\n/u);
    for (const command of commands) {
      const candidate = join(dirname(command), "node_modules", "pnpm", "bin", "pnpm.cjs");
      if (existsSync(candidate)) {
        pnpmCli = candidate;
        break;
      }
    }
  }
  if (!pnpmCli) throw new Error("Could not locate the pnpm CLI");
  try {
    execFileSync(process.execPath, [pnpmCli, ...arguments_], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    throw new Error([failed.stdout, failed.stderr].filter(Boolean).join("\n"), {
      cause: error,
    });
  }
};

interface PackageManifest {
  main?: string;
  types?: string;
  files?: string[];
  exports?: Record<string, string | Record<string, string>>;
}

describe("published package artifacts", () => {
  it("packs built entry points and installs them outside the workspace", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "canvas-package-contract-"));
    fixtureRoots.add(fixtureRoot);
    const archives: Record<string, string> = {};

    for (const directory of packageDirectories) {
      const packageRoot = join(workspaceRoot, "packages", directory);
      runPnpm(["pack", "--pack-destination", fixtureRoot], packageRoot);
      const archive = readdirSync(fixtureRoot).find((name) =>
        name.startsWith(`canvas-physics-${directory}-`),
      );
      expect(archive, `${directory} package archive`).toBeDefined();
      archives[directory] = join(fixtureRoot, archive!);

      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as PackageManifest;
      expect(manifest.main).toBe("./dist/index.js");
      expect(manifest.types).toBe("./dist/index.d.ts");
      expect(manifest.files).toEqual(["dist"]);
      expect(manifest.exports?.["."]).toEqual({
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      if (directory === "client") {
        expect(manifest.exports?.["./worker"]).toEqual({
          types: "./dist/simulation/simulation.worker.d.ts",
          default: "./dist/simulation/simulation.worker.js",
        });
        expect(manifest.exports?.["./worker-runtime"]).toEqual({
          types: "./dist/simulation/worker-runtime.d.ts",
          default: "./dist/simulation/worker-runtime.js",
        });
      }
    }

    const consumerRoot = join(fixtureRoot, "consumer");
    mkdirSync(consumerRoot, { recursive: true });
    const fileDependencies = Object.fromEntries(
      packageDirectories.map((directory) => [
        `@canvas-physics/${directory}`,
        `file:${archives[directory]!.replaceAll("\\", "/")}`,
      ]),
    );
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify({
        name: "canvas-package-consumer",
        private: true,
        type: "module",
        dependencies: fileDependencies,
      }),
    );
    writeFileSync(
      join(consumerRoot, "pnpm-workspace.yaml"),
      [
        "overrides:",
        ...Object.entries(fileDependencies).map(
          ([name, archive]) => `  '${name}': '${archive}'`,
        ),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumerRoot, "index.mjs"),
      [
        'import { BehaviorRegistry } from "@canvas-physics/core";',
        'import { PROTOCOL_VERSION } from "@canvas-physics/protocol";',
        'import { SimulationDriver } from "@canvas-physics/client";',
        'import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";',
        "if (!BehaviorRegistry || !PROTOCOL_VERSION || !SimulationDriver || !installSimulationWorker) process.exit(1);",
      ].join("\n"),
    );

    runPnpm(["install", "--prefer-offline", "--ignore-scripts"], consumerRoot);
    expect(
      existsSync(
        join(
          consumerRoot,
          "node_modules",
          "@canvas-physics",
          "client",
          "dist",
          "simulation",
          "simulation.worker.js",
        ),
      ),
    ).toBe(true);
    execFileSync(process.execPath, ["index.mjs"], {
      cwd: consumerRoot,
      stdio: "pipe",
    });
  }, 60_000);
});
