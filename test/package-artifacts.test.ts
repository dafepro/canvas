import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const executable = process.platform === "win32" ? findWindowsPnpm() : "pnpm";
  const isCommandShim = executable.toLowerCase().endsWith(".cmd");
  const pnpmCommand = isCommandShim ? (process.env.ComSpec ?? "cmd.exe") : executable;
  const pnpmArguments = isCommandShim
    ? ["/d", "/s", "/c", executable, ...arguments_]
    : arguments_;
  try {
    execFileSync(pnpmCommand, pnpmArguments, {
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

const findWindowsPnpm = (): string => {
  for (const name of ["pnpm.exe", "pnpm.cmd"]) {
    try {
      const resolved = execFileSync("where.exe", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split(/\r?\n/u)[0];
      if (resolved) return resolved;
    } catch {
      // Try the next supported Windows installation form.
    }
  }
  throw new Error("Could not locate pnpm.exe or pnpm.cmd on PATH");
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
        expect(manifest.exports?.["./runtime"]).toEqual({
          types: "./dist/runtime/index.d.ts",
          default: "./dist/runtime/index.js",
        });
        expect(manifest.exports?.["./worker"]).toEqual({
          types: "./dist/simulation/simulation.worker.d.ts",
          default: "./dist/simulation/simulation.worker.js",
        });
        expect(manifest.exports?.["./worker-runtime"]).toEqual({
          types: "./dist/simulation/worker-runtime.d.ts",
          default: "./dist/simulation/worker-runtime.js",
        });
        expect(manifest.exports?.["./testing"]).toEqual({
          types: "./dist/testing/index.d.ts",
          default: "./dist/testing/index.js",
        });
      } else if (directory === "core") {
        expect(manifest.exports?.["./testing"]).toEqual({
          types: "./dist/testing/index.d.ts",
          default: "./dist/testing/index.js",
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
        'import { runBehaviorConformance } from "@canvas-physics/core/testing";',
        'import { PROTOCOL_VERSION } from "@canvas-physics/protocol";',
        'import { PointerInteractionCoordinator, SimulationDriver, pointerInteractionPriorities } from "@canvas-physics/client/runtime";',
        'import { FaultInjectingWebSocketTransport, runRoomTransportConformance, runSimulationWorkerConformance } from "@canvas-physics/client/testing";',
        'import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";',
        "if (!BehaviorRegistry || !runBehaviorConformance || !PROTOCOL_VERSION || !SimulationDriver || !PointerInteractionCoordinator || pointerInteractionPriorities.itemEdit <= pointerInteractionPriorities.avatarMovement || !FaultInjectingWebSocketTransport || !runRoomTransportConformance || !runSimulationWorkerConformance || !installSimulationWorker) process.exit(1);",
        "const behavior = { behaviorType: 'fixture.counter', stateVersion: 1, subscribes: ['tick'], initialState: () => ({ ticks: 0 }), onEvent: (_context, _config, state) => ({ state: { ticks: state.ticks + 1 }, commands: [] }) };",
        "const report = runBehaviorConformance(behavior, {}, { scenarios: [{ name: 'tick', exercise: (harness) => { harness.advance(); } }] });",
        "if (!report.ok) throw new Error(JSON.stringify(report.issues));",
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

    for (const example of ["soccer-lounge", "item-playground", "linked-rooms"] as const) {
      const exampleSource = join(workspaceRoot, "examples", example);
      const exampleConsumer = join(fixtureRoot, example);
      mkdirSync(exampleConsumer, { recursive: true });
      for (const path of ["src", "public"]) {
        cpSync(join(exampleSource, path), join(exampleConsumer, path), { recursive: true });
      }
      for (const path of ["index.html", "tsconfig.json", "vite.config.ts"]) {
        cpSync(join(exampleSource, path), join(exampleConsumer, path));
      }
      writeFileSync(
        join(exampleConsumer, "package.json"),
        JSON.stringify({
          name: `canvas-packed-${example}-consumer`,
          private: true,
          type: "module",
          scripts: { build: "vite build" },
          dependencies: fileDependencies,
          devDependencies: { typescript: "^5.7.2", vite: "^6.0.7" },
        }),
      );
      writeFileSync(
        join(exampleConsumer, "pnpm-workspace.yaml"),
        [
          "overrides:",
          ...Object.entries(fileDependencies).map(
            ([name, archive]) => `  '${name}': '${archive}'`,
          ),
          "",
        ].join("\n"),
      );

      runPnpm(["install", "--prefer-offline", "--ignore-scripts"], exampleConsumer);
      runPnpm(["exec", "vite", "build", "--manifest"], exampleConsumer);
      expect(existsSync(join(exampleConsumer, "dist", "index.html"))).toBe(true);
      expect(
        readdirSync(join(exampleConsumer, "dist", "assets")).some((name) =>
          name.startsWith("canvas.worker-"),
        ),
      ).toBe(true);

      const viteManifest = JSON.parse(
        readFileSync(join(exampleConsumer, "dist", ".vite", "manifest.json"), "utf8"),
      ) as Record<
        string,
        { file: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[] }
      >;
      const browserEntry = Object.values(viteManifest).find(({ isEntry }) => isEntry);
      expect(browserEntry, `${example} browser entry`).toBeDefined();
      expect(browserEntry?.dynamicImports?.length).toBeGreaterThan(0);
      expect(
        statSync(join(exampleConsumer, "dist", browserEntry!.file)).size,
        `${example} must not eagerly download the Canvas runtime`,
      ).toBeLessThan(100_000);
    }
  }, 120_000);
});
